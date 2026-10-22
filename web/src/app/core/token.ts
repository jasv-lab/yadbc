import { HttpInterceptorFn } from '@angular/common/http'

/**
 * The host passes a per-launch token in the URL fragment (never sent to the server, never logged).
 * Kept in sessionStorage so a reload of the window keeps working; cleared from the address bar.
 */
function readToken(): string {
  const match = /token=([0-9a-f]+)/.exec(location.hash)
  if (match) {
    try {
      sessionStorage.setItem('yadbc.token', match[1])
    } catch {
      // storage unavailable: the in-memory value still works until reload
    }
    history.replaceState(null, '', location.pathname + location.search)
    return match[1]
  }
  try {
    return sessionStorage.getItem('yadbc.token') ?? ''
  } catch {
    return ''
  }
}

export const apiToken = readToken()

export const tokenInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ setHeaders: { 'X-Yadbc-Token': apiToken } }))
