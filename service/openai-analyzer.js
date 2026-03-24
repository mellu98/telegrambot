import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper per fetch intelligente (usa ScraperAPI se disponibile)
async function smartFetch(url, options = {}) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (apiKey && apiKey.trim() !== "") {
    const scraperUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=false`;
    return fetch(scraperUrl, {
      ...options,
      headers: { ...options.headers, "X-Proxy-Provider": "ScraperAPI" }
    });
  }
  return fetch(url, options);
}

// Fallback: Usa OpenRouter con un modello capace di navigare il web
async function fetchWithOpenRouterSearch(url) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY non configurata su Render.");

  console.log("Using OpenRouter Web Search Fallback for URL:", url);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://render.com",
      "X-Title": "Shopify Landing Bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001", // Modello con capacità di browsing/visione URL
      messages: [
        {
          role: "system",
          content: "Sei un analista e-commerce. Accedi al link AliExpress fornito e restituisci SOLO un oggetto JSON con: title, short_title, price, original_price, currency, images (array di URL), description (2 frasi), features (array di 5), category."
        },
        {
          role: "user",
          content: `Analizza questo prodotto: ${url}`
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  const data = await response.json();
  if (!data.choices?.[0]?.message?.content) {
    throw new Error("OpenRouter non ha restituito dati validi per il prodotto.");
  }
  return JSON.parse(data.choices[0].message.content);
}

// Step 1: Estrae dati prodotto da AliExpress via fetch + OpenAI enrichment
export async function extractProductData(url) {
  let realUrl = url;
  
  // Step 0: Risoluzione redirect preventiva (fondamentale per short URLs a.aliexpress.com)
  try {
    const redirectResp = await smartFetch(url, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!redirectResp.ok && (url.includes("a.aliexpress.com") || url.includes("_"))) {
      console.warn("Redirect fetch failed, trying OpenRouter fallback for short URL...");
      const fallbackData = await fetchWithOpenRouterSearch(url);
      return fallbackData; // Il modello restituisce già i dati completi
    }

    realUrl = redirectResp.url.split("?")[0];
    
    // Se ScraperAPI ha risolto il redirect, l'URL finale potrebbe essere nel query param 'url' o nell'URL stesso
    if (realUrl.includes("api.scraperapi.com")) {
      const u = new URL(realUrl);
      realUrl = u.searchParams.get("url") || realUrl;
    }
  } catch (err) {
    console.warn("Redirect resolution failed, trying OpenRouter fallback...", err.message);
    if (url.includes("a.aliexpress.com") || url.includes("_")) {
       return await fetchWithOpenRouterSearch(url);
    }
  }

  // Step 1: Estrazione ID dall'URL risolto
  let itemIdMatch = realUrl.match(/\/item\/(\d+)\.html/);
  
  if (!itemIdMatch) {
    const urlObj = new URL(realUrl);
    const productId = urlObj.searchParams.get("productId");
    if (productId) {
      itemIdMatch = [null, productId];
    }
  }
  
  if (!itemIdMatch) throw new Error("URL AliExpress non valido: manca l'item ID");

  // Step 1b: Fetch della pagina per estrarre dati dal HTML
  let html = "";
  let resp;
  try {
    resp = await smartFetch(realUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (!resp.ok) {
      console.warn(`Fetch fallito (HTTP ${resp.status}), provo il fallback OpenRouter...`);
      return await fetchWithOpenRouterSearch(realUrl);
    }
    html = await resp.text();
  } catch (err) {
    console.warn(`Network error during fetch (${err.message}), provo il fallback OpenRouter...`);
    return await fetchWithOpenRouterSearch(realUrl);
  }

  // Estrai dati dal HTML (og tags, immagini, ecc.)
  const ogTitle = html.match(/og:title"\s+content="(.*?)"/)?.[1] || "";
  const ogImage = html.match(/og:image"\s+content="(.*?)"/)?.[1] || "";

  // Estrai tutte le immagini prodotto (no thumbnail 80x80)
  const allImages = [...new Set(
    [...html.matchAll(/https:\/\/ae01\.alicdn\.com\/kf\/[^"'\s)]+/g)]
      .map(m => m[0])
      .filter(u => !u.includes("_80x80") && !u.includes("_50x50"))
  )];

  if (!ogTitle) {
    console.warn("Titolo non trovato nell'HTML, provo il fallback OpenRouter...");
    return await fetchWithOpenRouterSearch(realUrl);
  }

  // Step 1c: Usa OpenAI per analizzare il titolo e arricchire i dati
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: "You are a product data analyst. Given a product title and images from AliExpress, extract structured product information. Be accurate and concise.",
      },
      {
        role: "user",
        content: `Analyze this AliExpress product and return structured JSON data.

PRODUCT TITLE: ${ogTitle}
PRODUCT IMAGES: ${allImages.slice(0, 6).join(", ")}
PRODUCT URL: ${realUrl}

Return a JSON object:
{
  "title": "clean product title in English (fix any translation issues)",
  "short_title": "3-5 word short title",
  "price": "estimated price if visible, or empty string",
  "original_price": "original price if available, or empty string",
  "currency": "USD",
  "images": [${allImages.slice(0, 6).map(u => `"${u}"`).join(", ")}],
  "description": "product description based on title and category (2-3 sentences)",
  "features": ["5-6 key features based on the product title and type"],
  "specifications": {"key": "value pairs based on title info"},
  "category": "product category",
  "shipping_info": "standard AliExpress shipping",
  "orders_count": "",
  "review_summary": "",
  "variants": ["likely color/size options based on product type"],
  "material": "material from title if mentioned",
  "target_audience": "ideal buyer"
}

Return ONLY valid JSON.`,
      },
    ],
    response_format: { type: "json_object" }
  });

  const outputText = response.choices[0].message.content;
  try {
    const cleaned = outputText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const data = JSON.parse(cleaned);
    // Assicura che le immagini dal HTML siano sempre incluse
    if (allImages.length > 0) {
      data.images = allImages.slice(0, 6);
    }
    return data;
  } catch {
    throw new Error("Impossibile analizzare dati prodotto: " + outputText?.slice(0, 300));
  }
}

// Step 2: Generazione copy per landing page
// Output DEVE corrispondere esattamente ai campi del template-generator
export async function generateCopy(productData, copyInstructions = "") {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Sei un copywriter esperto per e-commerce italiano. Scrivi copy di vendita in italiano colloquiale e diretto, orientato ai benefici concreti del prodotto.

STILE "SIGNORA MARKET COPY":
- Parla come parleresti a una cliente al mercato
- Frasi corte, parole semplici, benefici CONCRETI e SPECIFICI
- Headline: aggettivo + nome prodotto + funzione + valore aggiunto
- Mai esagerare, mai sembrare falso
- Ogni frase deve descrivere un beneficio REALE e TANGIBILE, non generico
- NON scrivere frasi vuote tipo "Ottimo prodotto" o "Molto soddisfatto" - scrivi COSA fa il prodotto concretamente

LUNGHEZZE E STILE (copia queste lunghezze dal template master):

- product_subtitle: 1 frase specifica sul beneficio principale (es: "Sostegno discreto e effetto pushup per un profilo migliore sotto ogni abito")
- benefit_texts: emoji + frase COMPLETA che descrive un beneficio concreto (es: "⬆️ Solleva di una taglia immediatamente sotto abiti attillati", "👗 Mantiene aderente tutto il giorno senza spalline visibili"). Esattamente 4.
- inline_review_text: 2 frasi DETTAGLIATE e naturali di un cliente soddisfatto che descrive l'esperienza d'uso concreta (es: "Questo prodotto aderisce alla pelle e resta discreto sotto i vestiti, offre un supporto invisibile senza ganci ne spalline e regala un immediato effetto pushup che mi ha fatto sentire piu sicuro in ogni occasione.")
- image_text_sections heading: 5-8 parole che descrivono un beneficio specifico (es: "Niente spalline visibili sotto abiti attillati")
- image_text_sections text: 2-3 frasi RICCHE che spiegano il beneficio in dettaglio (es: "Aderisce alla pelle e resta discreto sotto vestiti sottili. Perfetto per camicie aderenti o abiti da sera, evita segni e distrazioni e mantiene un profilo pulito.")
- benefit_cards title: 1 parola (es: "Discrezione", "Sostegno")
- benefit_cards description: 1 frase COMPLETA con dettaglio (es: "Rimane invisibile sotto camicie e giacche, senza spalline visibili.", "Mantiene il seno sollevato tutto il giorno senza ganci o chiusure.")
- comparison_rows feature: 1 parola (es: "Adesione", "Comfort", "Estetica")
- percentage_stats text: 1 frase SPECIFICA con risultato concreto (es: "Segnalato aumento immediato della definizione del decollete sotto le camicie.", "Confermato comfort per l'intera giornata senza scivolamenti o aggiustamenti.")
- faq_items question: domanda specifica del cliente (es: "Cosa significa taglia unica? Andra bene per me?")
- faq_items answer: risposta LUNGA e dettagliata con elenchi puntati se serve (es: "Il nostro prodotto utilizza un tessuto ultra-elastico innovativo che si adatta a diverse corporature.\\n\\nAdatto per:\\n\\nCirconferenza: 65-85 cm\\nTaglie: Dalla S alla XL\\nCome funziona: Il tessuto elastico si modella sulle tue forme naturali.")
- reviews text: 1-3 frasi SPECIFICHE e naturali, con dettagli d'uso concreti (es: "All'inizio ero scettico, poi l'ho usato in macchina per una settimana e ho capito che e indispensabile; veramente sorprendente e pratico :)", "L'ho provato in vacanza: tiene bene, non si muove sul cruscotto e mantiene il telefono stabile tutto il giorno.")
- cta_heading: frase con nome prodotto e garanzia (es: "Provalo senza rischi: 30 giorni soddisfatti o rimborsati Supporto Magnetico")
- cta_text: 2-3 frasi DETTAGLIATE sulla garanzia (es: "Prova il Supporto Magnetico per 30 giorni. Se non ti piace la stabilita, la presa magnetica o la rotazione, restituisci il prodotto per il rimborso. Garanzia pensata per farti sentire sicuro nel provare una soluzione pratica e affidabile.")

${copyInstructions ? `ISTRUZIONI AGGIUNTIVE:\n${copyInstructions}` : ""}`,
      },
      {
        role: "user",
        content: `Genera TUTTO il copy per la landing page di questo prodotto. Tutto in italiano.

PRODOTTO:
${JSON.stringify(productData, null, 2)}

Rispondi con ESATTAMENTE questo JSON (rispetta ogni campo e numero di elementi):

{
  "product_subtitle": "frase subtitle sotto il titolo",
  "benefit_texts": [
    "emoji + beneficio 1",
    "emoji + beneficio 2",
    "emoji + beneficio 3",
    "emoji + beneficio 4"
  ],
  "inline_review_text": "testo testimonial inline nella sezione prodotto",
  "inline_review_name": "Nome C.",
  "image_text_sections": [
    {"heading": "titolo sezione immagine+testo 1", "text": "testo descrittivo"},
    {"heading": "titolo sezione immagine+testo 2", "text": "testo descrittivo"}
  ],
  "benefits_heading": "titolo sezione benefici",
  "benefits_subtitle": "sottotitolo sezione benefici",
  "benefit_cards": [
    {"icon": "emoji", "title": "Parola", "description": "descrizione breve"},
    {"icon": "emoji", "title": "Parola", "description": "descrizione breve"},
    {"icon": "emoji", "title": "Parola", "description": "descrizione breve"},
    {"icon": "emoji", "title": "Parola", "description": "descrizione breve"}
  ],
  "comparison_heading": "Perche [nome prodotto] si distingue",
  "comparison_description": "descrizione comparazione 1-2 frasi",
  "comparison_rows": [
    {"feature": "Parola"},
    {"feature": "Parola"},
    {"feature": "Parola"},
    {"feature": "Parola"},
    {"feature": "Parola"}
  ],
  "percentage_heading": "titolo sezione percentuali",
  "percentage_stats": {
    "percentage_1": 98,
    "text_1": "frase risultato 1",
    "percentage_2": 97,
    "text_2": "frase risultato 2",
    "percentage_3": 96,
    "text_3": "frase risultato 3"
  },
  "faq_heading": "Domande frequenti sul [nome prodotto]",
  "faq_description": "sottotitolo FAQ",
  "faq_items": [
    {"question": "domanda 1", "answer": "risposta 1"},
    {"question": "domanda 2", "answer": "risposta 2"},
    {"question": "domanda 3", "answer": "risposta 3"},
    {"question": "domanda 4", "answer": "risposta 4"}
  ],
  "cta_heading": "Prova [nome prodotto] con garanzia 30 giorni",
  "cta_text": "testo call to action con garanzia",
  "reviews": [
    {"name": "Nome C.", "rating": 4, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 5, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 4, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 4, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 4, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 5, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 5, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 5, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 4, "text": "testo recensione"},
    {"name": "Nome C.", "rating": 5, "text": "testo recensione"}
  ]
}

Rispondi SOLO con JSON valido, niente markdown, niente commenti.`,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 4096
  });

  const outputText = response.choices[0].message.content;
  try {
    const cleaned = outputText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Impossibile generare copy: " + outputText?.slice(0, 300));
  }
}

// Step 3: Analisi via Vision per Screenshot (Fallback)
export async function analyzeProductFromVision(imageBuffer, mimeType = "image/jpeg") {
  const base64Image = imageBuffer.toString('base64');

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: "Sei un analista di dati e-commerce. Estrai informazioni strutturate da uno screenshot di una pagina prodotto AliExpress o Amazon.",
      },
      {
        role: "user",
        messages: [
          {
            type: "text",
            text: `Analizza questo screenshot del prodotto e restituisci un oggetto JSON con queste chiavi:
{
  "title": "titolo pulito in Inglese",
  "short_title": "3-5 parole",
  "price": "prezzo visibile",
  "original_price": "prezzo originale se c'è",
  "currency": "EUR/USD",
  "images": [],
  "description": "breve descrizione (2-3 frasi)",
  "features": ["5-6 benefici chiave"],
  "category": "categoria del prodotto",
  "target_audience": "chi lo compra"
}
Restituisci SOLO il JSON.`
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`
            }
          }
        ]
      }
    ],
    response_format: { type: "json_object" }
  });

  const outputText = response.choices[0].message.content;
  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error("Impossibile analizzare lo screenshot: " + outputText?.slice(0, 300));
  }
}
