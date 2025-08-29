// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

interface RequestBody {
    journey_key: string;
}

interface ResponseBody {
    user_journey_id: string;
    journey_key: string;
    journey_title: string;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }

    try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const token = authHeader.replace("Bearer ", "");
        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const requestBody: RequestBody = await req.json();
        if (!requestBody.journey_key) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // Check if user already has an active journey for this journey_key
        const { data: existingJourney, error: existingError } = await db
            .from("user_journey")
            .select("id")
            .eq("user_id", userData.user.id)
            .eq("journey_key", requestBody.journey_key)
            .eq("is_active", true)
            .single();

        let userJourneyId: string;

        if (existingJourney) {
            // Use existing active journey
            userJourneyId = existingJourney.id;
        } else {
            // Create new active journey
            const { data: newJourney, error: createError } = await db
                .from("user_journey")
                .insert({
                    user_id: userData.user.id,
                    journey_key: requestBody.journey_key,
                    is_active: true
                })
                .select("id")
                .single();

            if (createError || !newJourney) {
                return new Response(JSON.stringify({ error: "Failed to create journey" }), {
                    status: 500,
                    headers: { "content-type": "application/json", ...CORS_HEADERS }
                });
            }

            userJourneyId = newJourney.id;
        }

        // Get journey title
        const { data: journeyData, error: journeyError } = await db
            .from("journeys")
            .select("title")
            .eq("key", requestBody.journey_key)
            .eq("is_active", true)
            .single();

        if (journeyError || !journeyData) {
            return new Response(JSON.stringify({ error: "Journey not found" }), {
                status: 404,
                headers: { "content-type": "application/json", ...CORS_HEADERS }
            });
        }

        const responseBody: ResponseBody = {
            user_journey_id: userJourneyId,
            journey_key: requestBody.journey_key,
            journey_title: journeyData.title
        };

        return new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });

    } catch (error) {
        console.error("Edge function error:", error);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "content-type": "application/json", ...CORS_HEADERS }
        });
    }
});
