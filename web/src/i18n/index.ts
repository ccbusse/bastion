import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { de } from './de';
import { en } from './en';

function initialLanguage() {
  try {
    const stored = localStorage.getItem('bastion.lang');
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    /* Speicher nicht verfügbar */
  }
  return navigator.language?.toLowerCase().startsWith('de') ? 'de' : navigator.language ? 'en' : 'de';
}

void i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
  returnNull: false,
});

i18n.on('languageChanged', (lng) => document.documentElement.setAttribute('lang', lng));
document.documentElement.setAttribute('lang', i18n.language);

export default i18n;
