-- MCQ Master: PUBLIC READ + PUBLIC WRITE
-- NO Supabase Auth / NO admin_users / NO admin UUID

-- Remove old admin objects and policies.
DROP FUNCTION IF EXISTS public.is_admin();
DROP TABLE IF EXISTS public.admin_users;

DROP POLICY IF EXISTS "Anyone can read categories" ON public.categories;
DROP POLICY IF EXISTS "Anyone can read questions" ON public.questions;
DROP POLICY IF EXISTS "Anyone can read question options" ON public.question_options;
DROP POLICY IF EXISTS "Admins can insert categories" ON public.categories;
DROP POLICY IF EXISTS "Admins can delete categories" ON public.categories;
DROP POLICY IF EXISTS "Admins can insert questions" ON public.questions;
DROP POLICY IF EXISTS "Admins can delete questions" ON public.questions;
DROP POLICY IF EXISTS "Admins can insert question options" ON public.question_options;
DROP POLICY IF EXISTS "Admins can delete question options" ON public.question_options;
DROP POLICY IF EXISTS "Public can insert categories" ON public.categories;
DROP POLICY IF EXISTS "Public can delete categories" ON public.categories;
DROP POLICY IF EXISTS "Public can insert questions" ON public.questions;
DROP POLICY IF EXISTS "Public can delete questions" ON public.questions;
DROP POLICY IF EXISTS "Public can insert question options" ON public.question_options;
DROP POLICY IF EXISTS "Public can delete question options" ON public.question_options;

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read categories"
ON public.categories FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Public can insert categories"
ON public.categories FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Public can delete categories"
ON public.categories FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Public can read questions"
ON public.questions FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Public can insert questions"
ON public.questions FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Public can delete questions"
ON public.questions FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Public can read question options"
ON public.question_options FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Public can insert question options"
ON public.question_options FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Public can delete question options"
ON public.question_options FOR DELETE TO anon, authenticated USING (true);
