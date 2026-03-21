import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useBilling } from '../hooks/useBilling'

interface Props {
  session: Session
  currentTier: string
  onClose: () => void
}

const tiers = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    channels: '1 channel',
    features: ['1 active channel', 'Basic chat', 'Community support'],
    color: 'slate',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$9',
    period: '/month',
    channels: '10 channels',
    features: ['10 active channels', 'Priority relay', 'Email support', 'Session history'],
    color: 'indigo',
    popular: true,
  },
  {
    id: 'max',
    name: 'Max',
    price: '$29',
    period: '/month',
    channels: 'Unlimited',
    features: ['Unlimited channels', 'Priority relay', 'Priority support', 'Session history', 'Team features'],
    color: 'amber',
  },
]

export function PricingModal({ session, currentTier, onClose }: Props) {
  const { checkout } = useBilling(session)
  const [upgrading, setUpgrading] = useState<string | null>(null)

  const handleUpgrade = async (tier: string) => {
    if (tier === 'free' || tier === currentTier) return
    setUpgrading(tier)
    const url = await checkout(tier)
    if (url) {
      window.open(url, '_blank')
    }
    setUpgrading(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-white">Choose Your Plan</h2>
              <p className="text-sm text-slate-400 mt-1">Scale your remote coding sessions</p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {tiers.map((tier) => {
              const isCurrent = tier.id === currentTier
              const borderColor = isCurrent
                ? tier.color === 'indigo' ? 'border-indigo-500' : tier.color === 'amber' ? 'border-amber-500' : 'border-slate-500'
                : 'border-slate-700'

              return (
                <div
                  key={tier.id}
                  className={`relative rounded-xl border ${borderColor} p-5 flex flex-col ${
                    tier.popular ? 'bg-slate-700/50' : 'bg-slate-800/50'
                  }`}
                >
                  {tier.popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-wider rounded-full">
                      Popular
                    </span>
                  )}
                  {isCurrent && (
                    <span className="absolute -top-3 right-3 px-3 py-0.5 bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-wider rounded-full">
                      Current
                    </span>
                  )}

                  <h3 className="text-lg font-bold text-white">{tier.name}</h3>
                  <div className="mt-2 mb-4">
                    <span className="text-3xl font-bold text-white">{tier.price}</span>
                    <span className="text-sm text-slate-400">{tier.period}</span>
                  </div>
                  <p className="text-sm font-medium text-indigo-300 mb-3">{tier.channels}</p>

                  <ul className="space-y-2 flex-1 mb-5">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
                        <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 8.5l3 3 7-7" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={() => handleUpgrade(tier.id)}
                    disabled={isCurrent || tier.id === 'free' || upgrading === tier.id}
                    className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isCurrent
                        ? 'bg-slate-700 text-slate-400 cursor-default'
                        : tier.id === 'free'
                        ? 'bg-slate-700/50 text-slate-500 cursor-default'
                        : tier.popular
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-white'
                    }`}
                  >
                    {upgrading === tier.id ? 'Redirecting...' : isCurrent ? 'Current Plan' : tier.id === 'free' ? 'Free' : 'Upgrade'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
