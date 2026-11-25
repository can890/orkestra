import { style } from '@vanilla-extract/css';

/*
 * Tek satırlık sistem bildirimi başlığı (ör. bağlam devri isteği).
 *
 * Simge ve metin aynı esnek satırda durur; simgenin kendi `display` değerine güvenilmez, çünkü
 * masaüstü uygulamasının Tailwind preflight'ı `svg { display: block }` der ve satır içi bir
 * `<span>` içindeki blok `svg` satırı ikiye böler (simge metnin üstüne düşer). Metin hiçbir
 * genişlikte satır kırmaz, sığmazsa üç noktayla kısalır: `measureSystemNotice` başlığı her zaman
 * tek satır sayar.
 */

/** CollapseHeader'ın etiket kutusu: daralabilsin (min-width 0) ki içerideki metin kısalabilsin. */
export const noticeLabel = style({
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

export const noticeGlyph = style({
  display: 'block',
  flexShrink: 0,
  marginRight: '6px',
});

export const noticeText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const noticeToggle = style({
  flexShrink: 0,
  marginLeft: '6px',
  opacity: 0.75,
  whiteSpace: 'nowrap',
});
