import { createController, type Controller } from '@orkestra/wire/rpc';
import { simulatorContract } from '../api';
import type { SimulatorService } from './simctl';

export function createSimulatorWireController(service: SimulatorService): Controller {
  return createController(simulatorContract, {
    availability: () => ({ supported: service.supported }),
    listDevices: () => service.listDevices(),
    bootDevice: ({ udid }) => service.bootDevice(udid),
    shutdownDevice: ({ udid }) => service.shutdownDevice(udid),
    screenshot: ({ udid }) => service.screenshot(udid),
    openUrl: ({ udid, url }) => service.openUrl(udid, url),
    installApp: ({ udid, appPath }) => service.installApp(udid, appPath),
    launchApp: ({ udid, bundleId }) => service.launchApp(udid, bundleId),
    setAppearance: ({ udid, appearance }) => service.setAppearance(udid, appearance),
    tap: ({ udid, x, y }) => service.tap(udid, x, y),
    swipe: ({ udid, x1, y1, x2, y2, durationMs }) =>
      service.swipe(udid, x1, y1, x2, y2, durationMs),
    inputText: ({ udid, text }) => service.inputText(udid, text),
    keyEvent: ({ udid, key }) => service.keyEvent(udid, key),
  });
}
