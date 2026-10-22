import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http'
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core'
import { tokenInterceptor } from './core/token'

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([tokenInterceptor])),
  ],
}
