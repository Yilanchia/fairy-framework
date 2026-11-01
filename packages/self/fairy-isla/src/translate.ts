import type { FairyFact, FairyIdentity, FairyStatus } from '@fairy/core'
import type { Fact, LifeState } from '@isla/life'

/**
 * Pure translations from an Isla life to Fairy's vocabulary. Kept apart from the service so they
 * can be tested without a running life, and so an Isla API change shows up in one place.
 */
export function toIdentity(state: LifeState): FairyIdentity {
  const { name, voice, origin } = state.genome
  return { name, voice, origin }
}

export function toStatus(state: LifeState): FairyStatus {
  return {
    at: state.at,
    asleep: state.asleep,
    ...(state.activity ? { doing: state.activity.label } : {}),
    mood: state.mood.valence,
    energy: state.energy,
    drives: { ...state.drives },
  }
}

export function toFacts(facts: readonly Fact[]): FairyFact[] {
  return facts.map(({ id, text }) => ({ id, text }))
}
