import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { VoiceSettingsPage } from '../browser/voice-settings-page';

export const voiceSettingsPage = defineSettingsPageContribution({
  id: 'voice',
  label: 'Ses',
  icon: 'mic',
  component: VoiceSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
