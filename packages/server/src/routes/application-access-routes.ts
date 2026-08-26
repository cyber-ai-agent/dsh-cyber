import type { Router } from '../http/router.js'
import { readJson, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { ApplicationAccessService } from '../services/application-access-service.js'

export function registerApplicationAccessRoutes(router: Router, access: ApplicationAccessService): void {
  router.get('/api/application-access', async ({ request, response }) => writeJson(response, 200, { access: await access.summary(request) }))
  router.post('/api/application-access/password', async ({ request, response }) => {
    const body = await readJson(request)
    writeJson(response, 200, { access: await access.setPassword(requiredString(body, 'password'), response) })
  })
  router.delete('/api/application-access/password', async ({ request, response }) => writeJson(response, 200, { access: await access.clearPassword(request, response) }))
  router.post('/api/application-access/unlock', async ({ request, response }) => {
    const body = await readJson(request)
    writeJson(response, 200, { access: await access.unlock(requiredString(body, 'password'), request, response) })
  })
  router.post('/api/application-access/recover', async ({ request, response }) => {
    const body = await readJson(request)
    writeJson(response, 200, { access: await access.recover(requiredString(body, 'recoveryCode'), requiredString(body, 'password'), request, response) })
  })
  router.post('/api/application-access/lock', ({ request, response }) => { access.lock(request, response); writeJson(response, 200, { ok: true }) })
}
