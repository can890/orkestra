import { CapacitorHttp } from '@capacitor/core';
import type { DeviceFlowHttp } from './github-device-flow';

/**
 * `github.com/login/*` tarayıcı CORS'una izin vermez; Android'de Capacitor'un yerel HTTP köprüsü
 * (`CapacitorHttp`) açıkça çağrılır. Genel `fetch` yaması (`capacitor.config.ts`) açılmaz: yalnızca
 * bu iki çağrı yerel köprüden geçer. İstek gövdesi (cihaz kodu) günlüğe yazılmaz.
 */
export const capacitorDeviceFlowHttp: DeviceFlowHttp = async ({ url, body }) => {
  const response = await CapacitorHttp.post({
    url,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: body,
    responseType: 'json',
    connectTimeout: 15_000,
    readTimeout: 15_000,
  });
  return { status: response.status, body: response.data };
};
