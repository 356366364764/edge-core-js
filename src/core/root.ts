import { compose, createStore, StoreEnhancer } from 'redux'
import { attachPixie, filterPixie, ReduxProps } from 'redux-pixies'
import { emit } from 'yaob'

import { EdgeContext, EdgeContextOptions } from '../types/types'
import { RootAction } from './actions'
import { filterLogs, LogBackend, makeLegacyConsole, makeLog } from './log/log'
import { loadStashes } from './login/login-stash'
import { PluginIos, watchPlugins } from './plugins/plugins-actions'
import { rootPixie, RootProps } from './root-pixie'
import { defaultLogSettings, reducer, RootState } from './root-reducer'

let allContexts: EdgeContext[] = []

// @ts-ignore `window` doesn't exist in React Native
const global: any = typeof window !== 'undefined' ? window : {}

const composeEnhancers =
  global.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ != null
    ? global.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({ name: 'core' })
    : compose

/**
 * Creates the root object for the entire core state machine.
 * This core object contains the `io` object, context options,
 * Redux store, and tree of background workers.
 */
export async function makeContext(
  ios: PluginIos,
  logBackend: LogBackend,
  opts: EdgeContextOptions
): Promise<EdgeContext> {
  const { io } = ios
  const {
    apiKey,
    appId = '',
    authServer = 'https://auth.airbitz.co/api',
    deviceDescription = null,
    hideKeys = false,
    plugins: pluginsInit = {}
  } = opts
  const logSettings = { ...defaultLogSettings, ...opts.logSettings }
  if (apiKey == null) {
    throw new Error('No API key provided')
  }

  // Create a redux store:
  const enhancers: StoreEnhancer<RootState, RootAction> = composeEnhancers()
  const redux = createStore(reducer, enhancers)

  // Create a log wrapper, using the settings from redux:
  logBackend = filterLogs(logBackend, () => {
    const state = redux.getState()
    return state.ready ? state.logSettings : logSettings
  })
  const log = makeLog(logBackend, 'edge-core')

  // Retrieve rate hint cache
  let rateHintCache = []
  try {
    rateHintCache = JSON.parse(await io.disklet.getText('rateHintCache.json'))
    log('Read rateHintCache.json success')
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Failure is ok if file doesn't exist
      try {
        await io.disklet.setText('rateHintCache.json', JSON.stringify([]))
        log('Create rateHintCache.json success')
      } catch (error) {
        log.error('Create rateHintCache.json failure', error.message)
        throw error
      }
    } else {
      log.error('Read rateHintCache.json error', error.message)
      throw error
    }
  }

  // Load the login stashes from disk:
  const stashes = await loadStashes(io.disklet, log)
  redux.dispatch({
    type: 'INIT',
    payload: {
      apiKey,
      appId,
      authServer,
      deviceDescription,
      hideKeys,
      logSettings,
      pluginsInit,
      rateHintCache,
      stashes
    }
  })

  // Subscribe to new plugins:
  const closePlugins = watchPlugins(
    ios,
    logBackend,
    pluginsInit,
    redux.dispatch
  )

  // Start the pixie tree:
  const mirror = { output: {} }
  const closePixie = attachPixie(
    redux,
    filterPixie(
      rootPixie,
      (props: ReduxProps<RootState, RootAction>): RootProps => ({
        ...props,
        close() {
          closePixie()
          closePlugins()
          redux.dispatch({ type: 'CLOSE' })
        },
        io: { ...io, console: makeLegacyConsole(logBackend) },
        log,
        logBackend,
        onError: error => {
          if (mirror.output.context && mirror.output.context.api) {
            emit(mirror.output.context.api, 'error', error)
          }
        }
      })
    ),
    e => log.error(e),
    output => (mirror.output = output)
  )

  const out = mirror.output.context.api
  allContexts.push(out)
  return out
}

/**
 * We use this for unit testing, to kill all core contexts.
 */
export function closeEdge(): void {
  for (const context of allContexts) context.close().catch(() => undefined)
  allContexts = []
}
