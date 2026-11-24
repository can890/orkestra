// Ayarlar → Arayüz sayfasındaki görünüm özelleştirme kartları.

import { BackgroundImageSection } from '../../browser/background-image-section';
import { CustomCssSection } from '../../browser/custom-css-section';
import { CustomThemesSection } from '../../browser/custom-themes-section';

export function CustomThemesCard() {
  return (
    <div className="rounded-lg border border-border bg-(--em-surface) px-3 py-3">
      <CustomThemesSection />
    </div>
  );
}

export function CustomCssCard() {
  return (
    <div className="rounded-lg border border-border bg-(--em-surface) px-3 py-3">
      <CustomCssSection />
    </div>
  );
}

export function BackgroundImageCard() {
  return (
    <div className="rounded-lg border border-border bg-(--em-surface) px-3 py-3">
      <BackgroundImageSection />
    </div>
  );
}
