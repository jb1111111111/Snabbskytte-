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
      signal: AbortSignal.timeout(8000),
    });
    if (!authResponse.ok) return json({ error: "Din inloggning kunde inte verifieras. Logga in igen." }, 401);
    const user = await authResponse.json();
    if (!user || !user.id) return json({ error: "Din inloggning kunde inte verifieras. Logga in igen." }, 401);

    const body = await req.json();
    if (!body || !body.stats || typeof body.stats !== "object") return json({ error: "Träningsstatistik saknas." }, 400);
    const statsText = JSON.stringify(body.stats);
    if (statsText.length > 12000) return json({ error: "Underlaget är för stort. Försök igen med färre träningsserier." }, 413);

    const prompt = [
      "Du är en saklig och uppmuntrande analytiker av precisionsresultat i pistolskytte. Svara på svenska.",
      "Analysera enhands (one_hand) och tvåhands (two_hand) helt separat. Jämför aldrig deras träffbilder eller prestationsnivåer direkt.",
      "Varje serie innehåller skott i faktisk ordningsföljd. Positioner är normaliserade mot 5-ringens radie: x positivt åt höger, y positivt uppåt. (0,0) är tavlans centrum.",
      "Undersök, när datamängden räcker: horisontell och vertikal spridning, riktad/elliptisk form, förskjutning från centrum, kvadrantfördelning, eventuella kluster eller avvikande skott samt skillnad mellan första och andra halvan av serien.",
      "Titta efter återkommande mönster över flera serier med samma skjutform. Ta hänsyn till pistol, avstånd och tidskrav. Jämför inte olika avstånd eller pistoler utan att tydligt redovisa skillnaden.",
      "Skilj strikt mellan observation och hypotes. En träffbild kan inte ensam bevisa ryck i avtrycket, felaktigt grepp eller felinställt sikte. Presentera sådant endast som möjliga förklaringar och föreslå hur de kan kontrolleras säkert, inte som diagnoser.",
      "Om positioner saknas eller antalet skott är litet, säg det och begränsa slutsatserna. Hitta aldrig på data eller orsaker.",
      "Ge: 1) kort nulägesbild per skjutform, 2) tydligaste observerade träffmönster, 3) vad som förändras i skottordningen, 4) högst två försiktigt formulerade utvecklingshypoteser, 5) ett konkret, säkert träningsförslag.",
      "Föreslå endast säkra, kontrollerade övningar med fokus på precision och konsekvens. Ge inga taktiska råd eller råd om att använda vapen mot människor.",
      "Träningsdata (JSON):",
      statsText,
    ].join("\n\n");

    // Börja med Googles snabba Flash-Lite-modell. Gå vidare om den är upptagen
    // eller långsam; varje modell får bara ett kort försök för att undvika timeout i Supabase.
    const models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
    let result: any = null;
    let lastStatus = 0;
    let timedOut = false;

    for (const model of models) {
      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(apiKey),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.25, maxOutputTokens: 500 },
            }),
            signal: AbortSignal.timeout(18000),
          },
        );

        if (response.ok) {
          result = await response.json();
          console.log("Gemini analysis completed with", model);
          break;
        }

        lastStatus = response.status;
        const errorBody = await response.json().catch(() => ({}));
        console.error("Gemini model error", model, response.status, errorBody?.error?.message || "unknown");

        if (response.status === 429) {
          return json({ error: "Googles kostnadsfria användningsgräns är nådd. Försök igen senare." }, 429);
        }
        // Försök nästa modell vid tillfällig överbelastning eller serverfel.
        if (response.status !== 503 && response.status !== 500 && response.status !== 502) break;
      } catch (modelError) {
        timedOut = modelError instanceof Error && modelError.name === "TimeoutError";
        console.error("Gemini request failed for", model, modelError);
        if (!timedOut) break;
      }
    }

    if (!result) {
      return json({
        error: timedOut
          ? "Googles AI-modeller svarade för långsamt. Försök igen om en stund."
          : lastStatus === 503 || lastStatus === 500 || lastStatus === 502
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
      ? "Supabase eller Google svarade inte i tid. Försök igen."
      : "Något gick fel när analysen skulle skapas. Kontrollera funktionsloggarna.";
    return json({ error: message }, 500);
  }
});
