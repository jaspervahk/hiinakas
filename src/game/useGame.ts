import { useReducer } from 'react'
import { gameReducer, makeInitialState } from './reducer'
import type { Action } from './reducer'
import type { GameState } from './types'

export function useGame(): [GameState, (action: Action) => void] {
  return useReducer(gameReducer, undefined, makeInitialState)
}
