import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigin = "https://jb1111111111.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : "null" } });
  }
  if (origin !== allowedOrigin) {
    return Response.json({ error: "Otillåten webbadress." }, { status: 403, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "Endast POST stöds." }, { status: 405, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    return Response.json({ error: "AI-funktionen är inte färdigkonfigurerad i Supabase." }, { status: 503, headers: corsHeaders });
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) {
    return Response.json({ error: "Logga in för att använda träningsanalysen." }, { status: 401, headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return Response.json({ error: "Din inloggning kunde inte verifieras. Logga in igen." }, { status: 401, headers: corsHeaders });
    }

    const body = await req.json();
    if (!body || !body.stats || typeof body.stats !== "object") {
      return Response.json({ error: "Träningsstatistik saknas." }, { status: 400, headers: corsHeaders });
    }
    const statsText = JSON.stringify(body.stats);
    if (statsText.length > 16000) {
      return Response.json({ error: "Underlaget är för stort. Försök igen med färre träningsserier." }, { status: 413, headers: corsHeaders });
    }

    const prompt = [
      "Du är en saklig och uppmuntrande träningsanalytiker för sportskytte med pistol.",
      "Analysera endast den bifogade träningsstatistiken. Svara på svenska och var konkret.",
      "Ge: 1) kort nulägesbild, 2) två tydliga styrkor eller positiva tecken, 3) högst två utvecklingsområden som faktiskt stöds av siffrorna, 4) ett enkelt förslag på vad skytten kan följa upp i nästa träningspass.",
      "Jämför bara grupper när det finns tillräckligt med data. Påpeka när underlaget är litet och dra inte långtgående slutsatser.",
      "Föreslå säkra, kontrollerade övningar med fokus på precision, konsekvens och tidshantering. Ge inga taktiska råd eller råd om att använda vapen mot människor.",
      "Hitta inte på siffror och säg tydligt till om statistiken inte räcker.",
      "Träningsdata (JSON):",
      statsText,
    ].join("\n\n");

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 750 },
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Gemini API error", response.status, result?.error?.message || "unknown");
      const status = response.status === 429 ? 429 : 502;
      const message = response.status === 429
        ? "Googles kostnadsfria användningsgräns är nådd just nu. Försök igen senare."
        : "Google kunde inte skapa analysen just nu. Försök igen senare.";
      return Response.json({ error: message }, { status, headers: corsHeaders });
    }

    const analysis = result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("").trim();
    if (!analysis) {
      return Response.json({ error: "AI:n gav inget analysresultat. Försök igen." }, { status: 502, headers: corsHeaders });
    }
    return Response.json({ analysis }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Training analysis failed", error);
    return Response.json({ error: "Något gick fel när analysen skulle skapas." }, { status: 500, headers: corsHeaders });
  }
});
