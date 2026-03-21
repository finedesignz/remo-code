import { Hono } from 'hono'
import Stripe from 'stripe'
import { supabaseAdmin } from '../db/supabase'

const billing = new Hono()

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || ''
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const APP_URL = process.env.VITE_HUB_URL || 'https://app.remo-code.com'

const stripe = new Stripe(STRIPE_SECRET)

// Map Stripe price IDs to tiers
const PRICE_TO_TIER: Record<string, string> = {
  'price_1Rm1l1EUEobFrZ7p2FsH1VuM': 'pro',
  // Add max price ID here when created in Stripe
}

const TIER_TO_PRICE: Record<string, string> = {
  pro: 'price_1Rm1l1EUEobFrZ7p2FsH1VuM',
}

// Create Stripe Checkout session
billing.post('/checkout', async (c) => {
  const userId = c.get('userId')
  const { tier } = await c.req.json<{ tier: string }>()

  const priceId = TIER_TO_PRICE[tier]
  if (!priceId) return c.json({ error: 'invalid tier' }, 400)

  // Get or create Stripe customer
  const { data: profileData } = await supabaseAdmin
    .from('profiles')
    .select('email, stripe_customer_id')
    .eq('id', userId)
    .single()

  let customerId = profileData?.stripe_customer_id

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profileData?.email || undefined,
      metadata: { user_id: userId },
    })
    customerId = customer.id
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId)
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL}?billing=success`,
    cancel_url: `${APP_URL}?billing=canceled`,
    metadata: { user_id: userId },
  })

  return c.json({ url: session.url })
})

// Create Stripe Customer Portal session
billing.post('/portal', async (c) => {
  const userId = c.get('userId')

  const { data: profileData } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single()

  if (!profileData?.stripe_customer_id) {
    return c.json({ error: 'no billing account' }, 404)
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: profileData.stripe_customer_id,
    return_url: APP_URL,
  })

  return c.json({ url: session.url })
})

// Get current subscription info
billing.get('/subscription', async (c) => {
  const userId = c.get('userId')

  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  return c.json({ subscription: data })
})

export { billing }

// Stripe webhook handler — separate from authenticated routes
export const billingWebhook = new Hono()

billingWebhook.post('/webhook', async (c) => {
  const body = await c.req.text()
  const sig = c.req.header('stripe-signature')

  if (!sig || !STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: 'missing signature' }, 400)
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET)
  } catch (err: any) {
    console.error('[stripe webhook] signature verification failed:', err.message)
    return c.json({ error: 'invalid signature' }, 400)
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.user_id
      if (!userId || !session.subscription) break

      // Fetch the subscription from Stripe
      const sub = await stripe.subscriptions.retrieve(session.subscription as string)
      const priceId = sub.items.data[0]?.price.id
      const tier = PRICE_TO_TIER[priceId] || 'pro'

      // Update profile tier
      await supabaseAdmin
        .from('profiles')
        .update({ tier, updated_at: new Date().toISOString() })
        .eq('id', userId)

      // Store subscription
      await supabaseAdmin
        .from('subscriptions')
        .upsert({
          id: sub.id,
          user_id: userId,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          updated_at: new Date().toISOString(),
        })

      console.log(`[stripe] user ${userId} upgraded to ${tier}`)
      break
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = sub.customer as string

      // Find user by stripe customer ID
      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (!profileData) break

      const priceId = sub.items.data[0]?.price.id
      const tier = PRICE_TO_TIER[priceId] || 'free'

      // Update tier based on subscription status
      const effectiveTier = sub.status === 'active' ? tier : 'free'
      await supabaseAdmin
        .from('profiles')
        .update({ tier: effectiveTier, updated_at: new Date().toISOString() })
        .eq('id', profileData.id)

      // Update subscription record
      await supabaseAdmin
        .from('subscriptions')
        .upsert({
          id: sub.id,
          user_id: profileData.id,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          updated_at: new Date().toISOString(),
        })

      console.log(`[stripe] user ${profileData.id} subscription updated: ${sub.status} -> ${effectiveTier}`)
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = sub.customer as string

      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (!profileData) break

      // Downgrade to free
      await supabaseAdmin
        .from('profiles')
        .update({ tier: 'free', updated_at: new Date().toISOString() })
        .eq('id', profileData.id)

      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', sub.id)

      console.log(`[stripe] user ${profileData.id} downgraded to free`)
      break
    }
  }

  return c.json({ received: true })
})
