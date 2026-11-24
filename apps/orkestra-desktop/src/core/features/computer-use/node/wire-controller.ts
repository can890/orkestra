import { createController, type Controller } from '@orkestra/wire/rpc';
import {
  computerUseContract,
  type ComputerUsePermissionPane,
  type ComputerUsePermissions,
} from '../api';
import type { ComputerUseState } from './computer-use-state';

export type ComputerUseControllerDeps = {
  state: ComputerUseState;
  permissions(): ComputerUsePermissions;
  /** Sistem Ayarları bölümünü açar; izin istemini tetiklemez. */
  openPermissionSettings(pane: ComputerUsePermissionPane): Promise<void>;
};

/**
 * Arayüzün kullandığı denetleyici. Genel ayar açıkken sohbetler varsayılan olarak etkindir;
 * kullanıcı arayüzden sohbeti durdurup yeniden açabilir. Kullanıcının arayüzdeki eylemi
 * dışında hiçbir şey (ajan, MCP, yapılandırma dosyası) durdurulan sohbeti tekrar açamaz.
 */
export function createComputerUseWireController(deps: ComputerUseControllerDeps): Controller {
  const { state } = deps;
  return createController(computerUseContract, {
    getState: async ({ conversationId }) => {
      const globalEnabled = state.supported ? await state.globalEnabled() : false;
      return {
        supported: state.supported,
        globalEnabled,
        conversationEnabled: globalEnabled && state.isConversationEnabled(conversationId),
        permissions: state.supported
          ? deps.permissions()
          : { accessibility: false, screenRecording: false },
        activity: state.activity(conversationId),
      };
    },
    setConversationEnabled: async ({ conversationId, enabled }) => {
      if (!enabled) {
        state.disableConversation(conversationId);
        return { success: true as const };
      }
      if (!state.supported) {
        return {
          success: false as const,
          error: 'Bilgisayar kullanımı yalnızca macOS’ta çalışır.',
        };
      }
      if (!(await state.globalEnabled())) {
        return {
          success: false as const,
          error: 'Önce Ayarlar > Genel bölümünden bilgisayar kullanımını açın.',
        };
      }
      state.enableConversation(conversationId);
      return { success: true as const };
    },
    stop: async ({ conversationId }) => {
      state.disableConversation(conversationId);
      return { success: true as const };
    },
    openPermissionSettings: async ({ pane }) => {
      if (!state.supported) {
        return {
          success: false as const,
          error: 'Bilgisayar kullanımı yalnızca macOS’ta çalışır.',
        };
      }
      try {
        await deps.openPermissionSettings(pane);
        return { success: true as const };
      } catch (error) {
        return { success: false as const, error: String(error) };
      }
    },
  });
}
