import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env BEFORE pipeline imports (they read env vars at init time)
dotenv.config({ path: join(__dirname, '../.env') });

// ─── Pipeline imports (after dotenv) ───
const { extractProductData, generateCopy, analyzeProductFromVision } = await import('./openai-analyzer.js');
const { generateLandingTemplate } = await import('./template-generator.js');
const shopify = await import('./shopify-client.js');
const { generateImageSet, CATEGORIES } = await import('./image-generator.js');
const { fixImagesForState } = await import('./fix-images.js');
const { convertLandingImages } = await import('./image-converter.js');

// ─── Render Web Service Dummy Server ───
// To keep the bot alive on Render Free Web Service tier, we must bind to a PORT.
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Dummy Express server listening on port ${PORT}`));

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token.trim() === "") {
  console.error("❌ ERRORE CRITICO: Token del bot assente.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Handle polling errors, especially 409 Conflict (multiple instances)
bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.error("=========================================");
    console.error("❌ ERRORE DI CONFLITTO (409):");
    console.error("Un'altra istanza del bot è già attiva con questo token.");
    console.error("Se il bot è attivo su Render.com, scollega l'istanza remota");
    console.error("prima di avviarlo in locale.");
    console.error("=========================================");
    // Optionally stop polling to avoid log spam, but the error itself usually stops it temporarily
  } else {
    console.error("Polling error:", error.code, error.message);
  }
});

// ─── Session matching and persistence ───
const SESSIONS_FILE = join(__dirname, 'sessions.json');
const STATES_DIR = join(__dirname, 'states');

if (!fs.existsSync(STATES_DIR)) fs.mkdirSync(STATES_DIR, { recursive: true });

function loadSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch (e) {
      console.error("Errore caricamento sessioni:", e);
      return {};
    }
  }
  return {};
}

function saveSessions(sessions) {
  // Clean history before saving to keep the file small (only save credentials)
  const toSave = {};
  for (const [id, s] of Object.entries(sessions)) {
    toSave[id] = { storeUrl: s.storeUrl, storeToken: s.storeToken };
  }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
}

const sessions = loadSessions();

// ─── State file management (User Specific) ───
function loadState(chatId) {
  const userStateFile = join(STATES_DIR, `state_${chatId}.json`);
  if (fs.existsSync(userStateFile)) {
    return JSON.parse(fs.readFileSync(userStateFile, 'utf-8'));
  }
  return {};
}

function saveState(chatId, state) {
  const userStateFile = join(STATES_DIR, `state_${chatId}.json`);
  fs.writeFileSync(userStateFile, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Tool definitions for GPT-4o ───
const tools = [
  {
    type: "function",
    function: {
      name: "set_active_store",
      description: "Imposta lo store Shopify attivo e il token di accesso per l'utente. Deve essere chiamato prima di interagire con Shopify.",
      parameters: {
        type: "object",
        properties: {
          storeUrl: { type: "string", description: "URL dello store Shopify (es: test-mcp-3.myshopify.com)" },
          token: { type: "string", description: "Access token Shopify (shpat_...)" }
        },
        required: ["storeUrl", "token"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_product",
      description: "Analizza un prodotto da un link AliExpress. Estrae titolo, prezzo, immagini, features, categoria e salva i dati per le fasi successive (generate_landing, push_to_shopify, generate_images). Usa questo come PRIMO step quando l'utente fornisce un URL AliExpress.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL del prodotto AliExpress" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_landing",
      description: "Genera il copy persuasivo in stile 'Signora Market Copy' e il template Shopify JSON completo per la landing page. Richiede che il prodotto sia già stato analizzato con analyze_product. Usa questo come SECONDO step.",
      parameters: {
        type: "object",
        properties: {
          copy_instructions: { type: "string", description: "Istruzioni extra per il copy (es: target, tono, focus specifico). Opzionale." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "push_to_shopify",
      description: "Pubblica il prodotto e la landing page su Shopify: crea il prodotto come draft, carica il template nel tema attivo, e assegna il template al prodotto. Richiede che la landing sia già stata generata con generate_landing e che lo store sia impostato con set_active_store. Usa questo come TERZO step.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_images",
      description: "Genera immagini AI professionali per il prodotto (Product Photo, Lifestyle, Infographic, How To, Social Proof) con OpenRouter + Gemini, le carica su Shopify Files e le assegna nelle sezioni corrette della landing page. Richiede che il prodotto sia già stato pubblicato con push_to_shopify. Usa questo come QUARTO e ULTIMO step.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "translate_landing",
      description: "Clona e traduce una landing page esistente in una nuova lingua (es: TEDESCO). Scarica il template JSON, traduce tutto il copy e lo salva come un nuovo modello (es: landing-DE). Mantiene le stesse immagini. Usa questo quando l'utente chiede di tradurre la landing page.",
      parameters: {
        type: "object",
        properties: {
          target_language: { type: "string", description: "La lingua di destinazione (es: 'tedesco', 'francese', 'inglese')" },
          new_template_suffix: { type: "string", description: "Suffisso per il nuovo template (es: 'DE', 'FR'). Opzionale." }
        },
        required: ["target_language"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_shopify_api",
      description: "SUPERPOTERE (God Mode): Esegue una richiesta API REST arbitraria a Shopify. Ti permette di compiere *qualsiasi* azione su Shopify: leggere/modificare/eliminare prodotti, variazioni, ordini, clienti, temi, etc. Usa l'ingegno per dedurre dal prompt dell'utente quale endpoint richiamare.",
      parameters: {
        type: "object",
        properties: {
          endpoint: { type: "string", description: "Soltanto il percorso relativo API (es. 'products.json' o 'products/12345/variants/6789.json'). Non includere /admin/api/2024-10/ o il server base." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "Verbo HTTP da eseguire sull'endpoint Shopify." },
          body: { type: "object", description: "Il payload JSON contenente i dati se passi una POST o PUT." }
        },
        required: ["endpoint", "method"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "convert_landing_images",
      description: "Scarica tutte le immagini di una landing page, le converte in formato WEBP per ottimizzare le prestazioni, le ricarica su Shopify Files e aggiorna il template della landing page. Da usare quando l'utente chiede di convertire o ottimizzare le immagini.",
      parameters: {
        type: "object",
        properties: {
          template_name: { type: "string", description: "Il nome del template della landing (es. landing-DE). Opzionale." }
        },
        required: []
      }
    }
  }
];

console.log("=========================================");
console.log("⚡ GOD MODE Multi-Store Bot STARTING...");
console.log("  Tools: set_active_store, analyze_product,");
console.log("  generate_landing, push_to_shopify,");
console.log("  generate_images, execute_shopify_api");
console.log("  Feature: Vision Fallback enabled");
console.log("=========================================");

// ─── Photo handler (Vision Fallback) ───
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const photo = msg.photo[msg.photo.length - 1]; // Highest resolution
  
  if (!sessions[chatId]) {
    bot.sendMessage(chatId, "Per favore, inviami prima il tuo store URL e il token (o scrivi /start) così so dove lavorare!");
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  bot.sendMessage(chatId, "📸 *Screenshot ricevuto!* Lo sto analizzando con l'IA per estrarre i dati del prodotto...", { parse_mode: 'Markdown' });

  try {
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    const buffer = await resp.buffer();

    const productData = await analyzeProductFromVision(buffer);
    const state = loadState(chatId);
    state.productData = productData;
    saveState(chatId, state);

    bot.sendMessage(chatId, `✅ *Analisi completata!*\n\n*Prodotto:* ${productData.title}\n*Prezzo:* ${productData.price} ${productData.currency}\n\nPosso generare la landing page per questo prodotto? Dimmi pure "vai" o "genera landing"!`, { parse_mode: 'Markdown' });

    // Update AI history so it knows we have the product data
    sessions[chatId].history.push({
      role: "assistant",
      content: `Ho analizzato lo screenshot del prodotto: ${productData.title}. I dati sono salvati nello stato. Attendo istruzioni per generare la landing.`
    });

  } catch (err) {
    console.error("Vision Analysis Error:", err);
    bot.sendMessage(chatId, "❌ Scusa, non sono riuscito ad analizzare correttamente la foto. Prova a mandarne una più nitida o usa un link diretto.");
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/start')) {
    bot.sendMessage(chatId, `🚀 *GOD MODE ATTIVATO* 🚀\nCiao ${msg.from.first_name}! Sono il tuo Shopify Bot avanzato.\n\n*Cosa posso fare:*\n1️⃣ Analizzare un prodotto da AliExpress\n2️⃣ Generare copy persuasivo + landing page\n3️⃣ Pubblicare tutto su Shopify\n4️⃣ Generare immagini AI professionali\n5️⃣ Convertire le immagini della landing in WEBP\n6️⃣ Qualsiasi operazione Shopify (God Mode)\n\nDammi prima le chiavi (URL e token) e poi mandami un link AliExpress!`, { parse_mode: 'Markdown' });
    return;
  }

  if (!sessions[chatId]) {
    sessions[chatId] = {
      storeUrl: null,
      storeToken: null,
      history: [{
        role: "system",
        content: `Sei un ingegnere e copywriter E-commerce di livello Director, connesso a un'interfaccia Telegram conversazionale per manipolare store Shopify.

HAI 8 TOOL POTENTISSIMI:

1. "set_active_store" — Imposta lo store Shopify (URL + token). CHIAMALO APPENA l'utente fornisce URL e token. Ricordati che queste informazioni vengono salvate permanentemente. È l'unico modo per cambiare negozio.`
      }]
    };
  } else if (!sessions[chatId].history) {
    // Restore history if it was just loaded from file (only has credentials)
    sessions[chatId].history = [{
      role: "system",
      content: `Sei un ingegnere e copywriter E-commerce di livello Director, connesso a un'interfaccia Telegram conversazionale per manipolare store Shopify.

HAI 8 TOOL POTENTISSIMI:

1. "set_active_store" — Imposta lo store Shopify (URL + token). CHIAMALO APPENA l'utente fornisce URL e token. Ricordati che queste informazioni vengono salvate permanentemente. È l'unico modo per cambiare negozio.

2. "analyze_product" — Analizza un prodotto AliExpress da URL. Estrae titolo, prezzo, immagini, features, categoria. CHIAMALO quando l'utente manda un link AliExpress.

3. "generate_landing" — Genera il copy in stile "Signora Market Copy" e il template Shopify completo. CHIAMALO dopo analyze_product.

4. "push_to_shopify" — Pubblica il prodotto (draft) e la landing page su Shopify. CHIAMALO dopo generate_landing.

5. "generate_images" — Genera immagini AI (Product Photo, Lifestyle, Infographic, How To, Social Proof), le carica su Shopify Files e le mappa nelle sezioni della landing. CHIAMALO dopo push_to_shopify.

6. "translate_landing" — Clona e traduce una landing page esistente in una nuova lingua (tedesco, etc.). Crea un nuovo modello (es: landing-DE) mantenendo le stesse immagini.

7. "execute_shopify_api" — God Mode: API REST Shopify arbitraria per qualsiasi operazione avanzata.

8. "convert_landing_images" — Scarica le immagini della landing dal template corretto, le converte in WEBP per migliorare il punteggio PageSpeed, e ricarica il template aggiornato. CHIAMALO quando l'utente vuole ottimizzare, convertire o migliorare la velocità.

FLUSSO TIPICO quando l'utente manda un link AliExpress:
1. analyze_product(url) → analizza il prodotto
2. generate_landing() → genera copy + template
3. push_to_shopify() → pubblica su Shopify
4. generate_images() → genera e carica immagini AI

TRADUZIONE:
Se l'utente chiede di tradurre una landing esistente (es: "traduci in tedesco"), usa "translate_landing(target_language='tedesco')".
NON cercare di tradurre manualmente usando execute_shopify_api a meno che non sia strettamente necessario.
- Esegui ogni step uno alla volta, comunicando il progresso all'utente tra uno step e l'altro
- Se l'utente fornisce URL e token insieme a un link prodotto, prima set_active_store poi analyze_product
- Sii amichevole, conciso, comunica solo i risultati formattati bene in italiano, con emoji adatte
- Se mancano store URL o token, chiedili prima di push_to_shopify
- Mai spiegare tecnicismi, solo risultati`
    }];
  }

  const session = sessions[chatId];
  session.history.push({ role: "user", content: text });
  bot.sendChatAction(chatId, 'typing');

  try {
    await processWithToolLoop(chatId, session);
  } catch (e) {
    console.error("Errore processamento:", e);
    bot.sendMessage(chatId, "❌ Si è verificato un errore critico. Riprova.");
  }
});

// ─── Multi-turn tool call loop ───
// GPT-4o can chain multiple tool calls across iterations
async function processWithToolLoop(chatId, session, maxIterations = 10) {
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: session.history,
        tools: tools,
        tool_choice: "auto"
      });
    } catch (apiError) {
      console.error("OpenAI API Error:", apiError.message);
      // If history is corrupted (missing tool responses), repair it
      if (apiError.message?.includes("tool_call_id") || apiError.message?.includes("tool_calls")) {
        console.log("Repairing corrupted history...");
        repairHistory(session);
        // Retry once after repair
        try {
          response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: session.history,
            tools: tools,
            tool_choice: "auto"
          });
        } catch (retryError) {
          console.error("Retry failed, resetting history:", retryError.message);
          resetSessionHistory(session);
          bot.sendMessage(chatId, "⚠️ Ho dovuto resettare la conversazione. Riprova il comando.");
          return;
        }
      } else {
        bot.sendMessage(chatId, "❌ Errore di comunicazione con l'AI. Riprova.");
        return;
      }
    }

    const choice = response.choices[0];
    const message = choice.message;
    session.history.push(message);

    // If there are no tool calls, send the final text response
    if (!message.tool_calls || message.tool_calls.length === 0) {
      if (message.content) {
        // Split long messages for Telegram (max 4096 chars)
        const text = message.content;
        if (text.length > 4000) {
          const chunks = text.match(/.{1,4000}/gs) || [text];
          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk);
          }
        } else {
          await bot.sendMessage(chatId, text);
        }
      }
      return; // Done — no more tool calls
    }

    // Process ALL tool calls and always push a response for each one
    for (const toolCall of message.tool_calls) {
      let resultStr = "";

      try {
        const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
        console.log(`[Tool Called] ${toolCall.function.name} — Args:`, JSON.stringify(args).substring(0, 200));

        switch (toolCall.function.name) {

          // ─── Tool: translate_landing ───
          case 'translate_landing': {
            if (!session.storeUrl || !session.storeToken) {
              resultStr = "Errore: store non impostato. Usa set_active_store.";
              break;
            }

            const targetLang = args.target_language || "tedesco";
            const suffix = args.new_template_suffix || (targetLang.substring(0, 2).toUpperCase());
            
            bot.sendMessage(chatId, `🌍 Traducendo la landing page in ${targetLang.toUpperCase()}...\nQuesto creerà un nuovo modello 'landing-${suffix}'.`);
            bot.sendChatAction(chatId, 'typing');

            try {
              // 1. Get active theme
              const themesRes = await fetch(`https://${session.storeUrl}/admin/api/2024-10/themes.json`, {
                headers: { "X-Shopify-Access-Token": session.storeToken }
              });
              const themesData = await themesRes.json();
              const activeTheme = themesData.themes.find(t => t.role === 'main');
              if (!activeTheme) throw new Error("Nessun tema attivo trovato.");

              // 2. Find the current landing template
              const assetsRes = await fetch(`https://${session.storeUrl}/admin/api/2024-10/themes/${activeTheme.id}/assets.json`, {
                headers: { "X-Shopify-Access-Token": session.storeToken }
              });
              const assetsData = await assetsRes.json();
              const templateAsset = assetsData.assets.find(a => a.key.startsWith('templates/product.landing-') && a.key.endsWith('.json'));
              
              if (!templateAsset) {
                // Fallback: check state
                const state = loadState(chatId);
                if (state.templateName && state.template) {
                  templateAsset = { key: `templates/product.${state.templateName}.json`, value: JSON.stringify(state.template) };
                } else {
                  throw new Error("Non ho trovato nessun template landing page da tradurre sullo store.");
                }
              }

              // 3. Read the template content
              let templateJson;
              if (templateAsset.value) {
                templateJson = JSON.parse(templateAsset.value);
              } else {
                const oneAssetRes = await fetch(`https://${session.storeUrl}/admin/api/2024-10/themes/${activeTheme.id}/assets.json?asset[key]=${templateAsset.key}`, {
                  headers: { "X-Shopify-Access-Token": session.storeToken }
                });
                const oneAssetData = await oneAssetRes.json();
                templateJson = JSON.parse(oneAssetData.asset.value);
              }

              // 4. Translate the JSON using GPT-4o
              bot.sendMessage(chatId, `🧠 Traduzione del copy in corso...`);
              const translationResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                  { role: "system", content: `Sei un traduttore esperto di e-commerce. Traduci tutto il testo contenuto in questo JSON PagePilot nella lingua: ${targetLang}. 
                  IMPORTANTE: 
                  - Traduci solo i valori di testo visibili (titoli, sottotitoli, descrizioni, benefici, recensioni, FAQ).
                  - NON tradurre ID, chiavi tecniche, nomi di tipi di sezione o URL (es. shopify://shop_images/...).
                  - Mantieni lo stile persuasivo e colloquiale.
                  - Restituisci SOLO il JSON tradotto senza markdown o spiegazioni.` },
                  { role: "user", content: JSON.stringify(templateJson) }
                ],
                response_format: { type: "json_object" }
              });

              const translatedTemplate = JSON.parse(translationResponse.choices[0].message.content);
              const newKey = `templates/product.landing-${suffix}.json`;

              // 5. Upload new template
              await fetch(`https://${session.storeUrl}/admin/api/2024-10/themes/${activeTheme.id}/assets.json`, {
                method: 'PUT',
                headers: { "X-Shopify-Access-Token": session.storeToken, "Content-Type": "application/json" },
                body: JSON.stringify({ asset: { key: newKey, value: JSON.stringify(translatedTemplate, null, 2) } })
              });

              resultStr = JSON.stringify({
                success: true,
                new_template: newKey,
                message: `Landing page tradotta con successo in ${targetLang}! Il nuovo modello si chiama 'landing-${suffix}'. Ora puoi assegnarlo al prodotto su Shopify.`
              });
            } catch (err) {
              console.error("Translation tool error:", err.message);
              resultStr = `Errore durante la traduzione: ${err.message}`;
            }
            break;
          }

          // ─── Tool: set_active_store ───
          case 'set_active_store': {
            session.storeUrl = args.storeUrl.replace("https://", "").replace("www.", "").replace(/\/$/, "").trim();
            session.storeToken = args.token.trim();
            saveSessions(sessions);
            resultStr = `Store impostato con successo su: ${session.storeUrl}. Queste credenziali sono state salvate e verranno usate per i prossimi comandi.`;
            break;
          }

          // ─── Tool: analyze_product ───
          case 'analyze_product': {
            bot.sendMessage(chatId, "🔍 Analizzando il prodotto da AliExpress...");
            bot.sendChatAction(chatId, 'typing');

            try {
              const productData = await extractProductData(args.url);
              const state = loadState(chatId);
              state.productData = productData;
              state.url = args.url;
              saveState(chatId, state);

              resultStr = JSON.stringify({
                success: true,
                title: productData.title,
                short_title: productData.short_title,
                price: productData.price,
                images: (productData.images || []).length,
                features: (productData.features || []).length,
                category: productData.category || "N/A",
                message: "Prodotto analizzato. Ora puoi usare generate_landing per generare la landing page."
              });
            } catch (err) {
              console.error("Extraction failed, suggesting vision fallback:", err.message);
              resultStr = JSON.stringify({
                success: false,
                error: err.message,
                suggestion: "AliExpress ha bloccato l'accesso automatico (Captcha/Bot detection). Chiedi all'utente di inviarti uno SCREENSHOT della pagina prodotto AliExpress: io la analizzerò automaticamente tramite Vision."
              });
            }
            break;
          }

          // ─── Tool: generate_landing ───
          case 'generate_landing': {
            const state = loadState(chatId);
            if (!state.productData) {
              resultStr = "Errore: nessun prodotto analizzato. Usa prima analyze_product con un URL AliExpress o inviami uno screenshot del prodotto.";
              break;
            }

            bot.sendMessage(chatId, "✍️ Generando copy persuasivo e template landing page...");
            bot.sendChatAction(chatId, 'typing');

            const copyData = await generateCopy(state.productData, args.copy_instructions || "");
            const { templateName, template } = generateLandingTemplate(state.productData, copyData);

            state.copyData = copyData;
            state.templateName = templateName;
            state.template = template;
            saveState(chatId, state);

            resultStr = JSON.stringify({
              success: true,
              subtitle: copyData.product_subtitle,
              cta: copyData.cta_heading,
              benefits: (copyData.benefit_cards || []).length,
              reviews: (copyData.reviews || []).length,
              faqs: (copyData.faq_items || []).length,
              templateName: templateName,
              message: "Landing page generata! Ora puoi usare push_to_shopify per pubblicarla."
            });
            break;
          }

          // ─── Tool: push_to_shopify ───
          case 'push_to_shopify': {
            if (!session.storeUrl || !session.storeToken) {
              resultStr = "Errore: store non impostato. Chiedi all'utente URL e token, poi usa set_active_store.";
              break;
            }

            const state = loadState(chatId);
            if (!state.template || !state.productData || !state.copyData) {
              resultStr = "Errore: nessuna landing pronta. Usa prima analyze_product e poi generate_landing.";
              break;
            }

            bot.sendMessage(chatId, "🚀 Pubblicando prodotto e landing page su Shopify...");
            bot.sendChatAction(chatId, 'typing');

            const result = await shopify.fullImport(
              session.storeUrl,
              session.storeToken,
              state.productData,
              state.copyData,
              state.templateName,
              state.template
            );

            state.shopifyProduct = result.product;
            state.shopifyUrl = result.productUrl;
            state.adminUrl = result.adminUrl;
            saveState(chatId, state);

            resultStr = JSON.stringify({
              success: true,
              productId: result.product.id,
              title: result.product.title,
              adminUrl: result.adminUrl,
              productUrl: result.productUrl,
              template: state.templateName,
              status: "draft",
              message: "Prodotto pubblicato come Draft! Ora puoi usare generate_images per generare le immagini AI."
            });
            break;
          }

          // ─── Tool: generate_images ───
          case 'generate_images': {
            const state = loadState(chatId);
            if (!state.productData || !state.shopifyProduct) {
              resultStr = "Errore: pubblica prima il prodotto con push_to_shopify.";
              break;
            }
            if (!session.storeUrl || !session.storeToken) {
              resultStr = "Errore: store non impostato. Usa set_active_store.";
              break;
            }

            bot.sendMessage(chatId, "🎨 Generando immagini AI professionali (5 categorie)...\nQuesto richiederà qualche minuto ⏳");
            bot.sendChatAction(chatId, 'upload_photo');

            const referenceImage = state.productData.images?.[0];
            if (!referenceImage) {
              resultStr = "Errore: nessuna immagine di riferimento trovata nel prodotto.";
              break;
            }

            const categoriesToGenerate = Object.keys(CATEGORIES);
            const imageResults = await generateImageSet(referenceImage, state.productData, categoriesToGenerate);

            const generated = imageResults.filter(r => !r.error).length;
            const failed = imageResults.filter(r => r.error).length;

            bot.sendMessage(chatId, `📸 ${generated} immagini generate! Caricandole su Shopify Files...`);
            bot.sendChatAction(chatId, 'upload_photo');

            // Fix images: upload to Shopify Files, map to template sections, re-upload template
            try {
              const imgDir = join(__dirname, 'generated-images');
              const fixResult = await fixImagesForState(state, session.storeUrl, session.storeToken, imgDir);
              saveState(chatId, fixResult.state);

              resultStr = JSON.stringify({
                success: true,
                generated: generated,
                failed: failed,
                uploaded: Object.keys(fixResult.uploadedUrls).length,
                message: `${generated} immagini AI generate e caricate su Shopify! Template aggiornato.`
              });
            } catch (fixErr) {
              console.error("Fix images error:", fixErr.message);
              resultStr = JSON.stringify({
                success: true,
                generated: generated,
                failed: failed,
                uploaded: 0,
                warning: "Immagini generate ma errore nell'upload alle sezioni template: " + fixErr.message,
                message: `${generated} immagini generate e aggiunte alla gallery prodotto, ma le sezioni template non sono state aggiornate.`
              });
            }
            break;
          }

          // ─── Tool: convert_landing_images ───
          case 'convert_landing_images': {
            if (!session.storeUrl || !session.storeToken) {
              resultStr = "Errore: chiedi all'utente di impostare lo store con set_active_store prima di convertire le immagini.";
              break;
            }
            
            bot.sendMessage(chatId, "🔄 Scaricando e convertendo le immagini della landing in WEBP...\nQuesto processo potrebbe richiedere qualche minuto ⏳");
            bot.sendChatAction(chatId, 'upload_photo');

            try {
              const conversionResult = await convertLandingImages(session.storeUrl, session.storeToken, args.template_name || "");
              
              if (conversionResult.success) {
                resultStr = JSON.stringify({
                  success: true,
                  message: conversionResult.message
                });
                bot.sendMessage(chatId, `✨ Conversion completata:\n${conversionResult.message}`);
              } else {
                resultStr = `Nessuna conversione completata: ${conversionResult.message}`;
              }
            } catch (convErr) {
              console.error("Errore conversione o caricamento immagini in WEBP:", convErr.message);
              resultStr = `Errore durante la conversione delle immagini: ${convErr.message}`;
            }
            break;
          }

          // ─── Tool: execute_shopify_api ───
          case 'execute_shopify_api': {
            if (!session.storeUrl || !session.storeToken) {
              resultStr = "Errore: chiedi all'utente di fornire l'URL del negozio e il token di accesso (shpat...) prima di chiamare questo tool.";
              break;
            }

            const options = {
              method: args.method,
              headers: {
                "X-Shopify-Access-Token": session.storeToken,
                "Content-Type": "application/json"
              }
            };
            if (args.body && (args.method === 'POST' || args.method === 'PUT')) {
              options.body = JSON.stringify(args.body);
            }
            const endpointClean = args.endpoint.replace(/^\/+/, '');
            const url = `https://${session.storeUrl}/admin/api/2024-10/${endpointClean}`;

            const res = await fetch(url, options);
            let responseData;
            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
              responseData = await res.json();
            } else {
              responseData = await res.text();
            }

            if (!res.ok) {
              resultStr = `L'API ha restituito codice d'errore HTTP ${res.status}: ${JSON.stringify(responseData)}`;
            } else {
              resultStr = typeof responseData === 'object' ? JSON.stringify(responseData) : responseData;
              if (resultStr.length > 30000) resultStr = resultStr.substring(0, 30000) + "...[TRUNCATED]";
            }
            break;
          }

          default:
            resultStr = `Tool sconosciuto: ${toolCall.function.name}`;
        }
      } catch (e) {
        console.error(`[Tool Error] ${toolCall.function.name}:`, e.message);
        resultStr = `Errore durante ${toolCall.function.name}: ${e.message}`;
      }

      // ALWAYS push tool response — this prevents history corruption
      session.history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultStr || "Operazione completata."
      });
    }

    // Continue the loop — GPT-4o will see tool results and decide next action
    bot.sendChatAction(chatId, 'typing');
  }

  // If we hit maxIterations, send a final message
  bot.sendMessage(chatId, "⚠️ Troppe iterazioni. Operazione completata parzialmente.");
}

// ─── History repair utilities ───
function repairHistory(session) {
  // Walk through history and remove orphaned tool_calls messages
  const repaired = [];
  for (let i = 0; i < session.history.length; i++) {
    const msg = session.history[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Check if ALL tool_call_ids have matching tool responses after this message
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      const remaining = session.history.slice(i + 1);
      const respondedIds = remaining.filter(m => m.role === 'tool').map(m => m.tool_call_id);
      const allResponded = toolCallIds.every(id => respondedIds.includes(id));

      if (!allResponded) {
        // Skip this broken assistant message and any partial tool responses
        console.log(`Removing broken tool_calls message at index ${i}`);
        continue;
      }
    }
    // Skip orphaned tool responses whose tool_call_id doesn't match any previous assistant message
    if (msg.role === 'tool') {
      const hasMatchingAssistant = repaired.some(
        m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === msg.tool_call_id)
      );
      if (!hasMatchingAssistant) {
        console.log(`Removing orphaned tool response at index ${i}`);
        continue;
      }
    }
    repaired.push(msg);
  }
  session.history = repaired;
}

function resetSessionHistory(session) {
  const systemMsg = session.history.find(m => m.role === 'system');
  session.history = systemMsg ? [systemMsg] : [];
}

