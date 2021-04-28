import { uncleaner } from 'cleaners'
import { base32, base64 } from 'rfc4648'

import {
  asChangeOtpPayload,
  asOtpResetPayload
} from '../../types/server-cleaners'
import { EdgeAccountOptions } from '../../types/types'
import { fixOtpKey, totp } from '../../util/crypto/hotp'
import { applyKit, searchTree, serverLogin } from '../login/login'
import { ApiInput } from '../root-pixie'
import { loginFetch } from './login-fetch'
import { getStash, hashUsername } from './login-selectors'
import { LoginStash } from './login-stash'
import { LoginKit, LoginTree } from './login-types'

const wasChangeOtpPayload = uncleaner(asChangeOtpPayload)

/**
 * Gets the current OTP for a logged-in account.
 */
export function getLoginOtp(login: LoginTree): string | undefined {
  if (login.otpKey != null) return totp(login.otpKey)
}

/**
 * Gets the current OTP from either the disk storage or login options.
 */
export function getStashOtp(
  stash: LoginStash,
  opts: EdgeAccountOptions
): string | undefined {
  const { otp, otpKey = stash.otpKey } = opts
  if (otp != null) {
    if (/[0-9]+/.test(otp) && otp.length < 16) return otp
    return totp(otp)
  }
  if (otpKey != null) return totp(otpKey)
}

export async function enableOtp(
  ai: ApiInput,
  accountId: string,
  otpTimeout: number
): Promise<void> {
  const { loginTree } = ai.props.state.accounts[accountId]

  const otpKey =
    loginTree.otpKey != null
      ? fixOtpKey(loginTree.otpKey)
      : base32.stringify(ai.props.io.random(10))

  const kit: LoginKit = {
    serverPath: '/v2/login/otp',
    server: wasChangeOtpPayload({
      otpKey,
      otpTimeout
    }),
    stash: {
      otpKey,
      otpResetDate: undefined,
      otpTimeout
    },
    login: {
      otpKey,
      otpResetDate: undefined,
      otpTimeout
    },
    loginId: loginTree.loginId
  }
  await applyKit(ai, loginTree, kit)
}

export async function disableOtp(
  ai: ApiInput,
  accountId: string
): Promise<void> {
  const { loginTree } = ai.props.state.accounts[accountId]

  const kit: LoginKit = {
    serverMethod: 'DELETE',
    serverPath: '/v2/login/otp',
    stash: {
      otpKey: undefined,
      otpResetDate: undefined,
      otpTimeout: undefined
    },
    login: {
      otpKey: undefined,
      otpResetDate: undefined,
      otpTimeout: undefined
    },
    loginId: loginTree.loginId
  }
  await applyKit(ai, loginTree, kit)
}

export async function cancelOtpReset(
  ai: ApiInput,
  accountId: string
): Promise<void> {
  const { loginTree } = ai.props.state.accounts[accountId]
  const { otpTimeout, otpKey } = loginTree
  if (otpTimeout == null || otpKey == null) {
    throw new Error('Cannot cancel 2FA reset: 2FA is not enabled.')
  }

  const kit: LoginKit = {
    serverPath: '/v2/login/otp',
    server: wasChangeOtpPayload({
      otpTimeout,
      otpKey
    }),
    stash: {
      otpResetDate: undefined
    },
    login: {
      otpResetDate: undefined
    },
    loginId: loginTree.loginId
  }
  await applyKit(ai, loginTree, kit)
}

/**
 * Requests an OTP reset.
 */
export async function resetOtp(
  ai: ApiInput,
  username: string,
  resetToken: string
): Promise<Date> {
  const request = {
    userId: base64.stringify(await hashUsername(ai, username)),
    otpResetAuth: resetToken
  }
  return await loginFetch(ai, 'DELETE', '/v2/login/otp', request).then(
    reply => {
      const { otpResetDate } = asOtpResetPayload(reply)
      return otpResetDate
    }
  )
}

/**
 * If the device doesn't have the right OTP key,
 * this can prevent most things from working.
 * Let the user provide an updated key, and present that to the server.
 * If the key works, the server will let us in & resolve the issue.
 */
export async function repairOtp(
  ai: ApiInput,
  accountId: string,
  otpKey: string
): Promise<void> {
  if (ai.props.state.accounts[accountId] == null) return
  const { login, loginTree } = ai.props.state.accounts[accountId]

  if (loginTree.username == null || login.passwordAuth == null) {
    throw new Error('Cannot sync: missing username')
  }
  const stashTree = getStash(ai, loginTree.username)
  const stash = searchTree(stashTree, stash => stash.appId === login.appId)
  if (stash == null) {
    throw new Error('Cannot sync: missing on-disk data')
  }
  if (login.passwordAuth == null) {
    throw new Error('Cannot repair OTP: There is no password on this account')
  }
  const request = {
    userId: login.userId,
    passwordAuth: base64.stringify(login.passwordAuth),
    otp: totp(otpKey)
  }
  const opts: EdgeAccountOptions = {
    // Avoid updating the lastLogin date:
    now: stashTree.lastLogin
  }
  await serverLogin(ai, stashTree, stash, opts, request, async () => {
    return login.loginKey
  })
}
