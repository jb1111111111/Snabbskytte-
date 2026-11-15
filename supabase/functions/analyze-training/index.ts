const allowedOrigin = "https://jb1111111111.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : "null" },
    });
  }
  if (origin !== allowedOrigin) return json({ error: "Otillåten webbadress." }, 403);
  if (req.method !== "POST") return json({ error: "Endast POST stöds." }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    return json({ error: "AI-funktionen är inte färdigkonfigurerad i Supabase." }, 503);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "Logga in för att använda träningsanalysen." }, 401);

  try {
    const authResponse = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: { "apikey": supabaseAnonKey, "Authorization": authorization },
    });
    if (!authResponse.ok) return json({ error: "Din inloggning kunde inte verifieras. Logga in igen." }, 401);
    const user = await authResponse.json();
    if (!user || !user.id) return json({ error: "Din inloggning kunde inte verifieras. Logga in igen." }, 401);

    const body = await req.json();
    if (!body || !body.stats || typeof body.stats !== "object") return json({ error: "Träningsstatistik saknas." }, 400);
    const statsText = JSON.stringify(body.stats);
    if (statsText.length > 12000) return json({ error: "Underlaget är för stort. Försök igen med färre träningsserier." }, 413);

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

    // Prova flera stabila Flash-modeller om en modell tillfälligt är överbelastad.
    const models = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
    let result: any = null;
    let lastStatus = 0;
    for (const model of models) {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(apiKey),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.35, maxOutputTokens: 750 },
            }),
            signal: AbortSignal.timeout(25000),
          },
        );
        if (response.ok) break;
        lastStatus = response.status;
        const errorBody = await response.json().catch(() => ({}));
        console.error("Gemini model error", model, response.status, errorBody?.error?.message || "unknown");
        if (response.status !== 503 && response.status !== 500) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (response?.ok) {
        result = await response.json();
        break;
      }
      if (lastStatus === 429) {
        return json({ error: "Googles kostnadsfria användningsgräns är nådd. Försök igen senare." }, 429);
      }
    }

    if (!result) {
      return json({
        error: lastStatus === 503 || lastStatus === 500
          ? "Googles AI-modeller är tillfälligt överbelastade. Försök igen om en stund."
          : "Google kunde inte skapa analysen. Kontrollera Gemini API-nyckeln och funktionsloggarna.",
      }, 502);
    }

    const analysis = result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("").trim();
    if (!analysis) return json({ error: "AI:n gav inget analysresultat. Försök igen." }, 502);
    return json({ analysis });
  } catch (error) {
    console.error("Training analysis failed", error);
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Gemini svarade inte inom 25 sekunder. Försök igen."
      : "Något gick fel när analysen skulle skapas. Kontrollera funktionsloggarna.";
    return json({ error: message }, 500);
  }
});
