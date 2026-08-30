-- RLS policies on public.users already exist; table/column grants for
-- authenticated were dropped so profile upsert/select returned permission denied
-- (logged as "Failed to upsert user: [object Object]").
-- Column-limited SELECT matches the documented contract (no email/avatar reads).

GRANT SELECT (id, name, referral_popup_shown) ON TABLE public.users TO authenticated;
GRANT INSERT (id, email, name, avatar_url) ON TABLE public.users TO authenticated;
GRANT UPDATE (email, name, avatar_url, referral_popup_shown) ON TABLE public.users TO authenticated;
-- DELETE already granted; keep it.

-- Append-only click analytics: policy exists, grant was missing.
GRANT INSERT ON TABLE public.button_clicks TO authenticated;
