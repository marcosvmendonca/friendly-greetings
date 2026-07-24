import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  // Locale travado em pt-BR. O dicionário ainda pode ser en.json (fallback)
  // até que messages/pt-BR.json seja preenchido — o importante é que
  // next-intl formate datas/números no padrão brasileiro.
  const locale = 'pt-BR';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
