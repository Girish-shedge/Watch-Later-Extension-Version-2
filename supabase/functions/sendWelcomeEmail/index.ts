// supabase/functions/sendWelcomeEmail/index.ts
import { serve }        from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend }       from "https://esm.sh/resend@4.5.1";

const URL        = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY   = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;

// manifest.json pins the extension id via its "key" field, so this origin is stable.
const EXTENSION_ORIGIN = "chrome-extension://hkekbdlgnmjpbaijipkanenaeabhegfk";

// Reflecting an arbitrary Origin let any website call this from a browser.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin === EXTENSION_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

serve(async (req) => {
  // ——— CORS PRE-FLIGHT ———
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods":     "POST, OPTIONS",
        "Access-Control-Allow-Headers":     "Authorization, Content-Type",
        "Access-Control-Max-Age":           "3600"
      }
    });
  }

  // ——— AUTHENTICATE ———
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  // validate user with anon-key + their JWT
  const userClient = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  // ——— ADMIN & EMAIL ———
  const admin  = createClient(URL, SRV_KEY);
  const resend = new Resend(RESEND_KEY);

  // 1) Check welcome flag in users table
  const { data: dbUser, error: fetchErr } = await admin
    .from("users")
    .select("welcome_email_sent")
    .eq("id", user.id)
    .single();

  if (fetchErr) {
    console.error("Error fetching welcome flag:", fetchErr);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
  if (dbUser?.welcome_email_sent) {
    // already sent—skip
    return new Response("Already sent", { status: 200, headers: corsHeaders });
  }

  // 2) Send the welcome email
  try {
    await resend.emails.send({
      from:    "Watch Later Extension <watchlaterextension@girishedge.in>",
      to:      user.email!,
      subject: "Welcome aboard! 🎉",
      html: `                                           
        <!-- Outer wrapper sets your font -->
        <div style="
          font-family: 'Manrope', sans-serif;
          background: rgb(255, 255, 255);
          max-width: 600px;
          margin: 0 auto;
        ">
          <!-- Clickable Banner -->
          <a
            href="https://watchlaterextension.in/"
            target="_blank"
            style="display:block; text-decoration:none; margin-bottom:24px;"
          >
            <img
              src="https://ayzqfwtoeckgycmqzlve.supabase.co/storage/v1/object/public/assets//Welcome-Mail.jpg"
              alt="Welcome to Watch Later Extension"
              style="
                display: block;
                width: 100%;
                height: auto;
                border-radius: 6px;
              "
            />
          </a>
        </div>
      `
    });
    console.log("📧 Sent welcome to", user.email);
  } catch (err) {
    console.error("Email send failed:", err);
    return new Response("Email error", { status: 500, headers: corsHeaders });
  }

  // 3) Mark it sent in users table
  const { error: updateErr } = await admin
    .from("users")
    .update({ welcome_email_sent: true })
    .eq("id", user.id);

  if (updateErr) {
    console.error("Error marking welcome flag:", updateErr);
    // you may still return OK, or handle according to your error policy
  }

  return new Response("OK", { status: 200, headers: corsHeaders });
});
