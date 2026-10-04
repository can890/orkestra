import type { RawServerEntry } from '@orkestra/core/primitives/mcp/api';

export interface CredentialKeyDef {
  key: string;
  required: boolean;
}

export interface CatalogEntryDef {
  config: RawServerEntry;
  name: string;
  description: string;
  docsUrl: string;
  credentialKeys: CredentialKeyDef[];
}

export const catalogData: Record<string, CatalogEntryDef> = {
  google_gmail: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'gmail'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Gmail',
    description: 'E-postaları arayın ve yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_drive: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'drive'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Drive',
    description: 'Dosyaları bulun ve yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_calendar: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'calendar'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Takvim',
    description: 'Takvimleri ve etkinlikleri yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_docs: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'docs'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Dokümanlar',
    description: 'Belgeleri okuyun ve düzenleyin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_sheets: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'sheets'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google E-Tablolar',
    description: 'Tabloları okuyun ve düzenleyin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_slides: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'slides'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Slaytlar',
    description: 'Sunumları oluşturun ve düzenleyin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_forms: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'forms'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Formlar',
    description: 'Formları ve yanıtları yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_tasks: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'tasks'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Görevler',
    description: 'Görev listelerini yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  google_chat: {
    config: {
      command: 'uvx',
      args: ['workspace-mcp==2.0.0', '--tools', 'chat'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'YOUR_CLIENT_ID',
        GOOGLE_OAUTH_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      },
    },
    name: 'Google Chat',
    description: 'Çalışma alanı sohbetlerini yönetin. Google hesabınızla giriş yapıp bağlayın.',
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    credentialKeys: [
      { key: 'GOOGLE_OAUTH_CLIENT_ID', required: true },
      { key: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true },
    ],
  },
  dropbox: {
    config: { type: 'http', url: 'https://mcp.dropbox.com/mcp', oauth: {} },
    name: 'Dropbox',
    description:
      'Dropbox dosyalarını ve klasörlerini arayın ve yönetin. Dropbox uygulama kaydı ve hesap onayı gerekir.',
    docsUrl: 'https://help.dropbox.com/integrations/connect-dropbox-mcp-server',
    credentialKeys: [],
  },
  box: {
    config: { type: 'http', url: 'https://mcp.box.com', oauth: {} },
    name: 'Box',
    description:
      'Box dosyalarını ve klasörlerini arayın ve yönetin. Kuruluş izni ve Box OAuth uygulama bilgileri gerekebilir.',
    docsUrl: 'https://github.com/box/mcp-server-box-remote',
    credentialKeys: [],
  },
  microsoft_365: {
    config: { command: 'npx', args: ['-y', '@microsoft/workiq@latest', 'mcp'] },
    name: 'Microsoft 365 / Work IQ',
    description:
      'Outlook e-postaları, toplantılar, belgeler ve Teams içeriklerinde arayın. Microsoft 365 Copilot lisansı ve kuruluş onayı gerekir.',
    docsUrl: 'https://github.com/microsoft/work-iq',
    credentialKeys: [],
  },
  openai_docs: {
    config: { type: 'http', url: 'https://developers.openai.com/mcp', oauth: false },
    name: 'OpenAI Belgeleri',
    description: 'OpenAI ve Codex geliştirme belgelerinde arayın.',
    docsUrl: 'https://developers.openai.com/learn/docs-mcp',
    credentialKeys: [],
  },

  elevenlabs: {
    config: {
      type: 'http',
      url: 'https://api.us.elevenlabs.io/v1/mcp',
      oauth: {},
    },
    name: 'ElevenLabs',
    description: 'Seslendirme, müzik ve ses üretin; ses dosyalarını yazıya çevirin.',
    docsUrl: 'https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp',
    credentialKeys: [],
  },
  playwright: {
    config: {
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    },
    name: 'Playwright',
    description: 'Tarayıcı işlemlerini Playwright ile otomatikleştirin.',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    credentialKeys: [],
  },
  context7: {
    config: {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      oauth: false,
      headers: {
        CONTEXT7_API_KEY: 'YOUR_API_KEY',
      },
    },
    name: 'Context7',
    description: 'Güncel geliştirme belgelerini ve kod örneklerini bulun.',
    docsUrl: 'https://github.com/upstash/context7',
    credentialKeys: [{ key: 'CONTEXT7_API_KEY', required: false }],
  },
  supabase: {
    config: {
      type: 'http',
      url: 'https://mcp.supabase.com/mcp',
    },
    name: 'Supabase',
    description: 'Veritabanlarını, kimlik doğrulamayı ve depolamayı yönetin.',
    docsUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
    credentialKeys: [],
  },
  vercel: {
    config: {
      type: 'http',
      url: 'https://mcp.vercel.com',
    },
    name: 'Vercel',
    description: 'Projeleri ve dağıtımları inceleyin ve yönetin.',
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    credentialKeys: [],
  },
  sentry: {
    config: {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    },
    name: 'Sentry',
    description: 'Uygulama hatalarını bulun ve inceleyin.',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    credentialKeys: [],
  },
  stripe: {
    config: {
      type: 'http',
      url: 'https://mcp.stripe.com',
    },
    name: 'Stripe',
    description: 'Ödemeleri ve finansal işlemleri yönetin.',
    docsUrl: 'https://docs.stripe.com/mcp',
    credentialKeys: [],
  },
  figma: {
    config: {
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
    },
    name: 'Figma',
    description: 'Figma tasarımlarından kod ve şemalar hazırlayın.',
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    credentialKeys: [],
  },
  linear: {
    config: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    },
    name: 'Linear',
    description: 'Linear görevlerini, projelerini ve iş akışlarını yönetin.',
    docsUrl: 'https://linear.app/docs/mcp',
    credentialKeys: [],
  },
  slack: {
    config: {
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
    },
    name: 'Slack',
    description: 'Slack mesajlarını ve çalışma alanı içeriklerini yönetin.',
    docsUrl: 'https://docs.slack.dev/ai/mcp-server',
    credentialKeys: [],
  },
  cloudflare: {
    config: {
      type: 'http',
      url: 'https://mcp.cloudflare.com/mcp',
    },
    name: 'Cloudflare Developer Platform',
    description: 'Cloudflare işlem, depolama ve yapay zekâ servislerini kullanın.',
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    credentialKeys: [],
  },
  netlify: {
    config: {
      type: 'http',
      url: 'https://netlify-mcp.netlify.app/mcp',
    },
    name: 'Netlify',
    description: 'Netlify sitelerini oluşturun ve yönetin.',
    docsUrl: 'https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/',
    credentialKeys: [],
  },
  chrome_devtools: {
    config: {
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
    },
    name: 'Chrome DevTools',
    description: 'Chrome üzerinden tarayıcı otomasyonu ve performans incelemesi yapın.',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    credentialKeys: [],
  },
  atlassian: {
    config: {
      type: 'http',
      url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    },
    name: 'Atlassian',
    description: 'Jira ve Confluence çalışma alanlarınıza erişin.',
    docsUrl:
      'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    credentialKeys: [],
  },
  notion: {
    config: {
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    },
    name: 'Notion',
    description: 'Notion sayfalarını ve çalışma alanı içeriklerini yönetin.',
    docsUrl: 'https://developers.notion.com/docs/mcp',
    credentialKeys: [],
  },
  notra: {
    config: {
      type: 'http',
      url: 'https://mcp.usenotra.com/mcp',
      headers: {
        Authorization: 'Bearer YOUR_API_KEY',
      },
    },
    name: 'Notra',
    description: 'Gönderileri, marka içeriklerini ve yayın takvimlerini yönetin.',
    docsUrl: 'https://docs.usenotra.com/devtools/mcp',
    credentialKeys: [{ key: 'Authorization', required: true }],
  },
  clerk: {
    config: {
      type: 'http',
      url: 'https://mcp.clerk.com/mcp',
    },
    name: 'Clerk',
    description: 'Kimlik doğrulama, kuruluş ve faturalandırma işlemlerini yönetin.',
    docsUrl: 'https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server',
    credentialKeys: [],
  },
  planetscale: {
    config: {
      type: 'http',
      url: 'https://mcp.pscale.dev/mcp/planetscale',
    },
    name: 'PlanetScale',
    description: 'Postgres ve MySQL veritabanlarınıza erişin.',
    docsUrl: 'https://planetscale.com/docs/connect/mcp',
    credentialKeys: [],
  },
  neon: {
    config: {
      type: 'http',
      url: 'https://mcp.neon.tech/mcp',
    },
    name: 'Neon',
    description: 'Neon veritabanlarını, branch ve sorgularını yönetin.',
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    credentialKeys: [],
  },
  bigquery: {
    config: {
      type: 'http',
      url: 'https://bigquery.googleapis.com/mcp',
    },
    name: 'Google Cloud BigQuery',
    description: 'BigQuery verilerini sorgulayın ve analiz edin.',
    docsUrl: 'https://cloud.google.com/bigquery/docs/use-bigquery-mcp',
    credentialKeys: [],
  },
  hugging_face: {
    config: {
      type: 'http',
      url: 'https://huggingface.co/mcp',
    },
    name: 'Hugging Face',
    description: 'Hugging Face modellerine ve Gradio uygulamalarına erişin.',
    docsUrl: 'https://huggingface.co/settings/mcp',
    credentialKeys: [],
  },
  exa: {
    config: {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: {
        'x-api-key': 'YOUR_EXA_API_KEY',
      },
    },
    name: 'Exa',
    description: 'İnternette ve kod kaynaklarında arama yapın.',
    docsUrl: 'https://exa.ai/docs/reference/exa-mcp',
    credentialKeys: [{ key: 'x-api-key', required: false }],
  },
  parallel: {
    config: {
      type: 'http',
      url: 'https://search.parallel.ai/mcp',
    },
    name: 'Parallel',
    description: 'İnternette arayın ve sayfa içeriklerini alın.',
    docsUrl: 'https://docs.parallel.ai/integrations/mcp/search-mcp',
    credentialKeys: [],
  },
  openrouter: {
    config: {
      type: 'http',
      url: 'https://mcp.openrouter.ai/mcp',
    },
    name: 'OpenRouter',
    description: 'OpenRouter modellerini, kredilerini ve belgelerini inceleyin.',
    docsUrl: 'https://openrouter.ai/docs/mcp-server',
    credentialKeys: [],
  },
  resend: {
    config: {
      command: 'npx',
      args: ['-y', 'resend-mcp'],
      env: {
        RESEND_API_KEY: 'YOUR_API_KEY',
      },
    },
    name: 'Resend',
    description: 'E-postaları, kişileri ve alan adlarını yönetin.',
    docsUrl: 'https://resend.com/docs/mcp-server',
    credentialKeys: [{ key: 'RESEND_API_KEY', required: true }],
  },
  posthog: {
    config: {
      type: 'http',
      url: 'https://mcp.posthog.com/mcp',
    },
    name: 'PostHog',
    description: 'PostHog verilerini sorgulayın ve analiz edin.',
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    credentialKeys: [],
  },
  honeycomb: {
    config: {
      type: 'http',
      url: 'https://mcp.honeycomb.io/mcp',
    },
    name: 'Honeycomb',
    description: 'Gözlemlenebilirlik verilerini ve hizmet hedeflerini inceleyin.',
    docsUrl: 'https://docs.honeycomb.io/integrations/mcp/configuration-guide',
    credentialKeys: [],
  },
  graphos: {
    config: {
      type: 'http',
      url: 'https://mcp.apollographql.com',
    },
    name: 'GraphOS MCP Tools',
    description: 'Apollo belgelerini ve geliştirme örneklerini arayın.',
    docsUrl: 'https://www.apollographql.com/docs/graphos/platform/graphos-mcp-tools',
    credentialKeys: [],
  },
  dev_manager: {
    config: {
      command: 'npx',
      args: ['dev-manager-mcp', 'stdio'],
    },
    name: 'Dev Manager',
    description: 'Geliştirme projelerini ve araçlarını yönetin.',
    docsUrl: 'https://github.com/BloopAI/dev-manager-mcp',
    credentialKeys: [],
  },
  sanity: {
    config: {
      type: 'http',
      url: 'https://mcp.sanity.io',
    },
    name: 'Sanity',
    description: 'Sanity içeriklerini oluşturun ve yönetin.',
    docsUrl: 'https://www.sanity.io/docs/ai/mcp-server',
    credentialKeys: [],
  },
  amplitude: {
    config: {
      type: 'http',
      url: 'https://mcp.amplitude.com/mcp',
    },
    name: 'Amplitude',
    description: 'Amplitude verilerini arayın ve analiz edin.',
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
    credentialKeys: [],
  },
  asana: {
    config: {
      type: 'http',
      url: 'https://mcp.asana.com/v2/mcp',
    },
    name: 'Asana',
    description: 'Asana görevlerini, projelerini ve hedeflerini yönetin.',
    docsUrl: 'https://developers.asana.com/docs/mcp-server',
    credentialKeys: [],
  },
  clickup: {
    config: {
      type: 'http',
      url: 'https://mcp.clickup.com/mcp',
    },
    name: 'ClickUp',
    description: 'ClickUp projelerini ve ekip çalışmalarını yönetin.',
    docsUrl: 'https://help.clickup.com/hc/en-us/articles/33335772678423-What-is-ClickUp-MCP',
    credentialKeys: [],
  },
  microsoft_learn: {
    config: {
      type: 'http',
      url: 'https://learn.microsoft.com/api/mcp',
      oauth: false,
    },
    name: 'Microsoft Learn',
    description: 'Microsoft geliştirme belgelerinde arayın.',
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    credentialKeys: [],
  },
  jam: {
    config: {
      type: 'http',
      url: 'https://mcp.jam.dev/mcp',
    },
    name: 'Jam',
    description: 'Ekran kaydı ve hata inceleme bilgilerini toplayın.',
    docsUrl: 'https://jam.dev/docs/jam-mcp',
    credentialKeys: [],
  },
  webflow: {
    config: {
      type: 'http',
      url: 'https://mcp.webflow.com/mcp',
    },
    name: 'Webflow',
    description: 'Webflow sitelerini, sayfalarını ve içeriklerini yönetin.',
    docsUrl: 'https://developers.webflow.com/mcp/reference/overview',
    credentialKeys: [],
  },
  cloudinary: {
    config: {
      type: 'http',
      url: 'https://asset-management.mcp.cloudinary.com/mcp',
    },
    name: 'Cloudinary',
    description: 'Görselleri ve videoları yönetin ve dönüştürün.',
    docsUrl: 'https://cloudinary.com/documentation/cloudinary_llm_mcp',
    credentialKeys: [],
  },
  wordpress: {
    config: {
      type: 'http',
      url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1',
    },
    name: 'WordPress',
    description: 'WordPress.com sitelerinizi yönetin.',
    docsUrl: 'https://developer.wordpress.com/docs/mcp/',
    credentialKeys: [],
  },
  canva: {
    config: {
      type: 'http',
      url: 'https://mcp.canva.com/mcp',
    },
    name: 'Canva',
    description: 'Canva tasarımlarını bulun, oluşturun ve dışa aktarın.',
    docsUrl: 'https://www.canva.dev/docs/mcp/',
    credentialKeys: [],
  },
  miro: {
    config: {
      type: 'http',
      url: 'https://mcp.miro.com/',
    },
    name: 'Miro',
    description: 'Miro panolarını ve içeriklerini yönetin.',
    docsUrl: 'https://developers.miro.com/docs/miro-mcp',
    credentialKeys: [],
  },
  intercom: {
    config: {
      type: 'http',
      url: 'https://mcp.intercom.com/mcp',
    },
    name: 'Intercom',
    description: 'Intercom müşteri ve destek verilerini inceleyin.',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    credentialKeys: [],
  },
  make: {
    config: {
      type: 'http',
      url: 'https://mcp.make.com',
    },
    name: 'Make',
    description: 'Make senaryolarını çalıştırın ve hesabınızı yönetin.',
    docsUrl: 'https://developers.make.com/mcp-server/',
    credentialKeys: [],
  },
  aws_marketplace: {
    config: {
      type: 'http',
      url: 'https://marketplace-mcp.us-east-1.api.aws/mcp',
    },
    name: 'AWS Marketplace',
    description: 'Bulut çözümlerini bulun ve değerlendirin.',
    docsUrl:
      'https://docs.aws.amazon.com/marketplace/latest/APIReference/marketplace-mcp-server.html',
    credentialKeys: [],
  },
  motherduck: {
    config: {
      type: 'http',
      url: 'https://api.motherduck.com/mcp',
    },
    name: 'MotherDuck',
    description: 'MotherDuck verilerinizi sorgulayın ve analiz edin.',
    docsUrl: 'https://motherduck.com/docs/sql-reference/mcp/',
    credentialKeys: [],
  },
  magic_patterns: {
    config: {
      type: 'http',
      url: 'https://mcp.magicpatterns.com/mcp',
    },
    name: 'Magic Patterns',
    description: 'Magic Patterns tasarımlarını geliştirin.',
    docsUrl: 'https://www.magicpatterns.com/docs/documentation/features/mcp-server/overview',
    credentialKeys: [],
  },
  wix: {
    config: {
      type: 'http',
      url: 'https://mcp.wix.com/mcp',
    },
    name: 'Wix',
    description: 'Wix sitelerini ve uygulamalarını yönetin.',
    docsUrl: 'https://dev.wix.com/docs/api-reference/articles/ai-tools/wix-mcp/about-the-wix-mcp',
    credentialKeys: [],
  },
  devrev: {
    config: {
      type: 'http',
      url: 'https://api.devrev.ai/mcp/v1',
      headers: {
        Authorization: 'Bearer YOUR_PAT',
      },
    },
    name: 'DevRev',
    description: 'Kuruluşunuzun DevRev bilgilerini arayın ve güncelleyin.',
    docsUrl:
      'https://support.devrev.ai/en-US/devrev/article/ZNqaZTsx-devrev-mcp-server-connect-your-ai-coding-assistant',
    credentialKeys: [{ key: 'Authorization', required: false }],
  },
  prisma: {
    config: {
      type: 'http',
      url: 'https://mcp.prisma.io/mcp',
    },
    name: 'Prisma',
    description: 'Prisma veritabanlarını ve geçişlerini yönetin.',
    docsUrl: 'https://docs.prisma.io/docs/ai/tools/mcp-server',
    credentialKeys: [],
  },
  railway: {
    config: {
      type: 'http',
      url: 'https://mcp.railway.com',
    },
    name: 'Railway',
    description: 'Railway projelerini ve servislerini yönetin.',
    docsUrl: 'https://docs.railway.com/ai/mcp-server',
    credentialKeys: [],
  },
  mongodb: {
    config: {
      command: 'npx',
      args: ['-y', 'mongodb-mcp-server@latest'],
      env: {
        MDB_MCP_CONNECTION_STRING: 'mongodb://localhost:27017/myDatabase',
      },
    },
    name: 'MongoDB',
    description: 'MongoDB veritabanlarını ve Atlas kümelerini yönetin.',
    docsUrl: 'https://www.mongodb.com/docs/mcp-server/',
    credentialKeys: [{ key: 'MDB_MCP_CONNECTION_STRING', required: true }],
  },
  monday: {
    config: {
      type: 'http',
      url: 'https://mcp.monday.com/mcp',
    },
    name: 'monday.com',
    description: 'monday.com panolarını ve iş akışlarını yönetin.',
    docsUrl: 'https://developer.monday.com/api-reference/docs/monday-mcp-overview',
    credentialKeys: [],
  },
  shopify: {
    config: {
      command: 'npx',
      args: ['-y', '@shopify/dev-mcp@latest'],
    },
    name: 'Shopify Dev',
    description: 'Shopify belgelerini ve GraphQL şemalarını arayın; uygulama kodunu doğrulayın.',
    docsUrl: 'https://shopify.dev/docs/apps/build/ai-toolkit',
    credentialKeys: [],
  },
  graphite: {
    config: {
      command: 'gt',
      args: ['mcp'],
    },
    name: 'Graphite',
    description: 'Graphite ile birbirine bağlı pull request çalışmalarını yönetin.',
    docsUrl: 'https://graphite.com/docs/gt-mcp',
    credentialKeys: [],
  },
  executor: {
    config: {
      command: 'executor',
      args: ['mcp'],
    },
    name: 'Executor',
    description: 'MCP, OpenAPI ve GraphQL araç bağlantılarını birleştirin.',
    docsUrl: 'https://executor.sh/docs',
    credentialKeys: [],
  },
  axiom: {
    config: {
      type: 'http',
      url: 'https://mcp.axiom.co/mcp',
    },
    name: 'Axiom',
    description: 'Axiom günlüklerini, ölçümlerini ve uyarılarını sorgulayın.',
    docsUrl: 'https://axiom.co/docs/console/intelligence/mcp-server',
    credentialKeys: [],
  },
  azure: {
    config: {
      command: 'npx',
      args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    },
    name: 'Azure MCP Server',
    description: 'Azure kaynaklarını ve bulut işlemlerini yönetin.',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/',
    credentialKeys: [],
  },
};
