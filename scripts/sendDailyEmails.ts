import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend }           from "https://esm.sh/resend@4.5.1";

// ——————————————————————————————————————————————————————————
// Setup
// ——————————————————————————————————————————————————————————
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const resend = new Resend(
  Deno.env.get("RESEND_API_KEY")!
);

async function main() {
  console.log("🔔 sendDailyEmails invoked at", new Date().toISOString());

  // 1️⃣ Fetch all Auth users
  const { data: authList, error: ue } =
    await supabase.auth.admin.listUsers();
  if (ue) {
    console.error("Failed to list auth users:", ue);
    Deno.exit(1);
  }

  const users = authList?.users ?? [];
  console.log(`👥 Found ${users.length} users`);

  for (const u of users) {
    if (!u.email) {
      console.log("⏭ Skipping user without email:", u.id);
      continue;
    }
    console.log("🔄 Processing user:", u.id, u.email);

    // ——————————————————————————————————————————————————————————
    // 2️⃣ Fetch that user’s unwatched video history
    // ——————————————————————————————————————————————————————————
    // We'll greet them by metadata.name if present, else local-part of email
    const userName =
      u.user_metadata?.name
      ?? u.email.split("@")[0]
      ?? "there";

    const { data: videos, error: ve } = await supabase
      .from("videohistory")
      .select("title, thumbnail, video_url")
      .eq("user_id", u.id)
      .eq("watched", false)
      .order("start_time", { ascending: true });

    if (ve) {
      console.error("Error fetching videohistory for", u.id, ve);
      continue;
    }
    console.log(`   📚 Found ${videos?.length ?? 0} unwatched videos`);
    if (!videos?.length) continue;

    // ——————————————————————————————————————————————————————————
    // 3️⃣ Build the HTML payload
    // ——————————————————————————————————————————————————————————
// build each video card
const itemsHtml = videos.map(video => `
  <div style="display:flex;align-items:center;margin-bottom:20px;">
    <img
      src="${video.thumbnail}"
      alt="Thumbnail for ${video.title}"
      style="width:120px;height:auto;border-radius:4px;margin-right:16px;object-fit:cover;"
    />
    <div>
      <p style="font-size:16px;margin:0 0 8px;line-height:1.2;">
        ${video.title}
      </p>
      <a
        href="${video.video_url}"
        style="
          display:inline-block;
          padding:12px 16px;
          background-color:#FF5722;
          color:#fff;
          text-decoration:none;
          border-radius:12px;
          font-weight:600;
          font-size:14px;
        "
      >
        Watch Now
      </a>
    </div>
  </div>
`).join("");

// wrap it all in one gradient container
const html = `
  <div
    style="
      font-family:'Gilory',sans-serif;
      max-width:600px;
      margin:0 auto;
      padding:24px;
      border-radius:16px;
      background: transparent;
      color: #687076;
    "
  >
    <!-- Greeting -->
    <h2 style="font-size:24px; margin-bottom:8px;">
      Hey, ${userName}
    </h2>

    <!-- Summary -->
    <p style="font-size:16px; margin:0 0 20px;">
      You still have <strong>${videos.length}</strong>
      video${videos.length===1?"":"s"} saved to watch:
    </p>

    <!-- Video list -->
    ${itemsHtml}

    <!-- Sign-off -->
    <p style="margin-top:40px; font-size:16px; line-height:1.4;">
      Cheers,<br/>
      <strong>Girish Shedge</strong><br/>
      Author of Watch Later Extension
    </p>

    <!-- Footer note -->
    <p style="font-size:14px; margin-top:8px;">
      Made with lots of effort.
    </p>
  </div>
`;


    // ——————————————————————————————————————————————————————————
    // 4️⃣ Send the email
    // ——————————————————————————————————————————————————————————
    try {
      const resp = await resend.emails.send({
        from:    "Watch Later Extension <watchlaterextension@girishedge.in>",
        to:      u.email,
        subject: "You’ve got videos waiting! 👀",
        html
      });
      console.log("✅ Sent to", u.email, "→", resp.id);
    } catch (err) {
      console.error("❌ Failed to send to", u.email, err);
    }
  }
}

main().catch(err => {
  console.error("Fatal error in main():", err);
  Deno.exit(1);
});
