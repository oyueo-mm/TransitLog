import { useLiveQuery } from 'dexie-react-hooks'
import { useSyncExternalStore } from 'react'
import { db } from '../db/db'
import { syncController } from '../sync/instance'

export function useSyncStatus() {
  return useSyncExternalStore(syncController.subscribe, syncController.getStatus)
}
export function useSyncConflicts() {
  return useLiveQuery(() => db.syncConflicts.toArray().then((r) => r.sort((a, b) => b.at - a.at)), [])
}
export function useSyncSnapshots() {
  return useLiveQuery(() => db.syncSnapshots.toArray().then((r) => r.sort((a, b) => b.at - a.at)), [])
}
