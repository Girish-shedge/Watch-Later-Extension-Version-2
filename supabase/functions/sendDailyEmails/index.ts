import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Resend } from 'https://esm.sh/resend@4.5.1';  // pin a version!

// Supabase (service-role) & Resend keys injected as env vars
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!);

serve(async () => {
  // 1️⃣ List every Auth user
  const { data: listData, error: listError } = 
    await supabase.auth.admin.listUsers();
  if (listError) throw listError;

  const users = listData?.users ?? [];
  console.log(`Found ${users.length} users`);

  for (const u of users) {
    if (!u.email) continue;

    // 2️⃣ Fetch that user’s unwatched video history
    // (real table is `videohistory` with `title`/`start_time`;
    //  the old `video_history`/`video_title`/`watched_at` names never existed)
    const { data: videos, error: ve } = await supabase
      .from('videohistory')
      .select('title, start_time')
      .eq('user_id', u.id)
      .eq('watched', false)
      .order('start_time', { ascending: true });

    if (ve || !videos?.length) continue;

    // 3️⃣ Build the HTML
    const items = videos.map(v =>
      `<li>${v.title} — ${new Date(v.start_time)
         .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      </li>`
    ).join('');
    const html = `
      <p>Hello,</p>
      <p>Here’s your video history for today:</p>
      <ul>${items}</ul>
      <p>— Your App Team</p>
    `;

    // 4️⃣ Send via Resend
    try {
      const resp = await resend.emails.send({
        from: "Watch Later Extension <watchlaterextension@girishedge.in>",
        to:      u.email,
        subject: 'This one is waiting for you',
        html
      });
      console.log(`Sent to ${u.email}: ${resp.id}`);
    } catch (err) {
      console.error(`Failed to send to ${u.email}`, err);
    }
  }

  return new Response('OK');
});
