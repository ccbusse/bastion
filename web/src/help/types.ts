/**
 * Hilfe-Artikel: liegen als Daten im Code (wie die Übersetzungen), damit sie zur Version passen, offline verfügbar sind
 * und ohne Markdown-Parser oder innerHTML auskommen.
 *
 * Inline-Auszeichnung in allen Texten: **fett**, `Code` und [Linktext](Ziel). Ziel ist eine Route der App (/vault)
 * oder ein anderer Artikel (help:items).
 */

/** Wer den Artikel in der Übersicht sieht. Die Inhalte sind nicht geheim, die Auswahl dient nur der Übersicht. */
export type Audience = 'all' | 'admin' | 'system';

export type Category = 'basics' | 'admin' | 'operations';

export type Block =
  | { h: string }
  | { p: string }
  | { list: string[] }
  | { steps: string[] }
  | { tip: string }
  | { warn: string }
  | { code: string };

export interface Article {
  id: string;
  category: Category;
  audience: Audience;
  title: string;
  /** Ein Satz für die Übersicht und die Suche */
  summary: string;
  body: Block[];
  related?: string[];
}
