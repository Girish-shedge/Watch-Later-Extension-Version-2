// supabase/functions/sendreferralnotification/index.ts
//
// Emails a referrer when someone redeems their code.
//
// SECURITY: nothing in the request body is trusted. The caller's JWT identifies
// the redeemer, and referrer / code / friend name are all read back from the
// redemption row that belongs to that caller. The previous version took
// referrerId + friendName + referralCode from the body, so any signed-in user
// could mail arbitrary users arbitrary HTML from our sending domain, and probe
// which user ids exist via the 404.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@4.5.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;

// manifest.json pins the extension id via its "key" field, so this origin is stable.
const EXTENSION_ORIGIN = "chrome-extension://hkekbdlgnmjpbaijipkanenaeabhegfk";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin === EXTENSION_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Display names come from Google profiles; keep them out of the header line.
function plain(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
}

serve(async (req) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "3600"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response("Unauthorized", { status: 401, headers: cors });

  // getUser() rejects the anon key, which platform-level verify_jwt would accept.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SRV_KEY);

  const { data: redemption, error: redErr } = await admin
    .from("referral_redemptions")
    .select("id, referral_code_id, notified_at")
    .eq("redeemed_user_id", user.id)
    .maybeSingle();

  if (redErr) {
    console.error("Redemption lookup failed:", redErr);
    return new Response("Internal error", { status: 500, headers: cors });
  }
  if (!redemption) {
    return new Response("No referral redemption for this user", { status: 403, headers: cors });
  }
  // One notification per redemption: otherwise a caller can replay this and
  // mailbomb the referrer from our domain.
  if (redemption.notified_at) {
    return new Response("Already sent", { status: 200, headers: cors });
  }

  const { data: codeRow, error: codeErr } = await admin
    .from("referral_codes")
    .select("code, user_id")
    .eq("id", redemption.referral_code_id)
    .single();
  if (codeErr || !codeRow) {
    console.error("Referral code lookup failed:", codeErr);
    return new Response("Internal error", { status: 500, headers: cors });
  }
  if (codeRow.user_id === user.id) {
    return new Response("Cannot refer yourself", { status: 400, headers: cors });
  }

  const [{ data: referrer, error: refErr }, { data: friend }] = await Promise.all([
    admin.from("users").select("email, name").eq("id", codeRow.user_id).single(),
    admin.from("users").select("name").eq("id", user.id).maybeSingle()
  ]);
  if (refErr || !referrer?.email) {
    console.error("Referrer lookup failed:", refErr);
    return new Response("Internal error", { status: 500, headers: cors });
  }

  const { count } = await admin
    .from("referral_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("referral_code_id", redemption.referral_code_id);
  const totalReferrals = count ?? 0;

  const friendName = plain(friend?.name) || "A friend";

  try {
    await resendSend(referrer, friendName, codeRow.code, totalReferrals);
  } catch (err) {
    console.error("Resend send error:", err);
    return new Response("Email send failed", { status: 500, headers: cors });
  }

  const { error: markErr } = await admin
    .from("referral_redemptions")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", redemption.id);
  if (markErr) console.error("Failed to mark redemption notified:", markErr);

  return new Response("OK", { status: 200, headers: cors });
});

async function resendSend(
  referrer: { email: string; name: string | null },
  friendName: string,
  referralCode: string,
  totalReferrals: number
) {
  const resend = new Resend(RESEND_KEY);
  await resend.emails.send({
    from: "Watch Later Extension <watchlaterextension@girishedge.in>",
    to: referrer.email,
    subject: `🎉 Your friend ${friendName} just joined with your code!`,
    html: `
        <div style="
          font-family: 'Manrope', sans-serif;
          max-width: 600px;
          margin: 24px 0;
          background: #ffffff;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(0,0,0,0.05);
          text-align: left;
        ">
          <a href="https://watchlaterextension.in" target="_blank" rel="noopener noreferrer" style="display:block; text-decoration:none;">
            <img
              src="https://ayzqfwtoeckgycmqzlve.supabase.co/storage/v1/object/public/assets/Banner-Referral-Mail.jpg"
              alt="Refer & Win a free month of Premium!"
              style="width:100%; height:auto; display:block;"
            />
          </a>
          <div style="padding: 16px; text-align: left;">
            <h1 style="margin: 0 0 16px; font-size: 20px; color: #333;">
              Hey ${esc(plain(referrer.name))},
            </h1>
            <p style="margin:0 0 8px; font-size:16px; color:#333;">
              Your friend <strong>${esc(friendName)}</strong> just used your referral code:
            </p>
            <p style="margin:0 0 16px; font-size:18px; font-weight:700; color:#333;">
              ${esc(referralCode)}
            </p>
            <div style="
              display: inline-block;
              background: #F5F5F5;
              padding: 8px 12px;
              border-radius: 4px;
              font-weight: 700;
              color: #333;
              margin-bottom: 24px;">
              Total referred friends: ${totalReferrals}
            </div>
            <p style="margin:0 0 24px; font-size:16px; color:#555;">
              Thanks for spreading the love! You’ve earned an extra entry into this month’s Premium giveaway.
            </p>
          </div>
          <div style="background:#F9F9F9; padding:16px 0; font-size:12px; color:#888; text-align:center;">
            <a href="https://watchlaterextension.in/share" target="_blank" style="margin:0 8px; color:inherit; text-decoration:none;">Share</a> |
            <a href="https://watchlaterextension.in/privacy-policy" target="_blank" style="margin:0 8px; color:inherit; text-decoration:none;">Privacy Policy</a> |
            <a href="https://watchlaterextension.in/community" target="_blank" style="margin:0 8px; color:inherit; text-decoration:none;">Community</a>
          </div>
        </div>
      `
  });
}
