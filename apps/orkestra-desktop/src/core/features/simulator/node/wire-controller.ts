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
  });
}
