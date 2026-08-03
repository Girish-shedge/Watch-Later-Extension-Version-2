import { serve }        from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend }       from "https://esm.sh/resend@4.5.1";

const URL        = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY   = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;

console.log("▶️ sendReferralNotification starting up");
console.log("🔑 RESEND_KEY present?:", !!RESEND_KEY);

serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "*";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":      origin,
        "Access-Control-Allow-Methods":     "POST, OPTIONS",
        "Access-Control-Allow-Headers":     "Authorization, Content-Type",
        "Access-Control-Max-Age":           "3600"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Access-Control-Allow-Origin": origin }
    });
  }

  const corsHeaders = { "Access-Control-Allow-Origin": origin };

  console.log("📨 Received", req.method, "→", req.url);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  console.log("🛂 JWT provided?:", !!jwt);
  if (!jwt) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const userClient = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  console.log("👤 Auth lookup:", user?.id, "err:", userErr);
  if (userErr || !user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  let payload: { referrerId: string; friendName: string; referralCode: string };
  try {
    payload = await req.json();
    console.log("📦 Payload:", payload);
  } catch (e) {
    console.log("❌ JSON parse error:", e);
    return new Response("Bad Request", { status: 400, headers: corsHeaders });
  }

  const { referrerId, friendName, referralCode } = payload;

  const admin = createClient(URL, SRV_KEY);

  const { data: referrer, error: refErr } = await admin
    .from("users")
    .select("email,name")
    .eq("id", referrerId)
    .single();

  console.log("🔎 Referrer lookup:", referrer, "err:", refErr);
  if (refErr || !referrer) {
    return new Response("Referrer not found", { status: 404, headers: corsHeaders });
  }

  const { data: referralCodeRow, error: referralLookupError } = await admin
    .from("referral_codes")
    .select("id")
    .eq("code", referralCode)
    .single();

  if (referralLookupError || !referralCodeRow) {
    console.error("❌ Referral code not found:", referralLookupError);
    return new Response("Invalid referral code", { status: 404, headers: corsHeaders });
  }

  // ✅ Correct referral count logic
  const { data: redemptions, error } = await admin
    .from("referral_redemptions")
    .select("id")
    .eq("referral_code_id", referralCodeRow.id);

  const totalReferrals = redemptions?.length || 0;
  console.log("📊 Total referrals:", totalReferrals);

  const resend = new Resend(RESEND_KEY);
  console.log("✉️ Sending via Resend to", referrer.email);
  try {
    const sendResult = await resend.emails.send({
      from:    "Watch Later Extension <watchlaterextension@girishedge.in>",
      to:      referrer.email,
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
              Hey ${referrer.name},
            </h1>
            <p style="margin:0 0 8px; font-size:16px; color:#333;">
              Your friend <strong>${friendName}</strong> just used your referral code:
            </p>
            <p style="margin:0 0 16px; font-size:18px; font-weight:700; color:#333;">
              ${referralCode}
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
    console.log("✅ Resend.send result:", sendResult);
  } catch (err) {
    console.error("❌ Resend.send error:", err);
    return new Response("Email send failed", { status: 500, headers: corsHeaders });
  }

  console.log("🏁 Completed sendReferralNotification");
  return new Response("OK", { status: 200, headers: corsHeaders });
});
