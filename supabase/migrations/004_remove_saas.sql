-- Remove SaaS-specific schema from open source app
-- (billing, tiers, subscriptions moved to remo-code-saas)

-- Drop subscriptions table
DROP TABLE IF EXISTS subscriptions;

-- Remove SaaS columns from profiles
ALTER TABLE profiles DROP COLUMN IF EXISTS tier;
ALTER TABLE profiles DROP COLUMN IF EXISTS stripe_customer_id;

-- Drop SaaS-related indexes
DROP INDEX IF EXISTS idx_profiles_tier;
DROP INDEX IF EXISTS idx_profiles_stripe;

-- Drop admin-read-all policy (admin dashboard is SaaS-only)
DROP POLICY IF EXISTS profiles_admin_select ON profiles;
