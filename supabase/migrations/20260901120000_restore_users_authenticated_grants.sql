-- Column grants on public.users for authenticated dropped again after 2026-08-29.
-- Without INSERT/UPDATE, profile upsert is permission denied; prefs/scores/button_clicks then fail FK.

GRANT SELECT (id, name, referral_popup_shown) ON TABLE public.users TO authenticated;
GRANT INSERT (id, email, name, avatar_url) ON TABLE public.users TO authenticated;
GRANT UPDATE (email, name, avatar_url, referral_popup_shown) ON TABLE public.users TO authenticated;
GRANT INSERT ON TABLE public.button_clicks TO authenticated;
