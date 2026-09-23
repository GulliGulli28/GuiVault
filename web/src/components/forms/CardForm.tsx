import { useState } from "react";
import type { VaultIndex } from "../../lib/entities";
import { cardBrand, emptyCard } from "../../lib/items";
import type { Card, Payload } from "../../lib/types";
import { PasswordInput } from "../ui";
import { Field, FormShell, useSeed } from "./common";
import { SecretFooter, SecretHeader } from "./SecretBits";

const BRANDS = ["Visa", "Mastercard", "American Express", "Discover", "Diners Club", "JCB", "UnionPay", "Maestro", "Autre"];
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

export function CardForm({ initial, index, defaultGroupId, onSave, onCancel }: {
  initial?: Card;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const [card, setCard] = useState<Card>(useSeed(initial, (p) => (p.kind === "card" ? p.card : undefined)) ?? emptyCard(defaultGroupId ?? null));
  const year = new Date().getFullYear();
  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouvelle carte"} onSave={() => onSave({ kind: "card", card: { ...card, name: card.name.trim(), number: card.number.replace(/\s+/g, "") } })} onCancel={onCancel} validate={() => (card.name.trim() ? null : "Le nom est obligatoire.")}>
      <SecretHeader value={card} onChange={setCard} placeholder="Carte pro, Visa perso…" />
      <Field label="Titulaire">
        <input value={card.cardholderName} onChange={(e) => setCard({ ...card, cardholderName: e.target.value })} autoComplete="off" className="input" />
      </Field>
      <div className="grid grid-cols-[1fr_10rem] gap-2">
        <Field label="Numéro">
          <input value={card.number} onChange={(e) => { const number = e.target.value; setCard({ ...card, number, brand: card.brand || cardBrand(number) }); }} inputMode="numeric" autoComplete="off" className="input input-mono" />
        </Field>
        <Field label="Marque">
          <select value={card.brand} onChange={(e) => setCard({ ...card, brand: e.target.value })} className="input">
            <option value="">—</option>
            {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            {card.brand && !BRANDS.includes(card.brand) && <option value={card.brand}>{card.brand}</option>}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Mois">
          <select value={card.expMonth} onChange={(e) => setCard({ ...card, expMonth: e.target.value })} className="input">
            <option value="">—</option>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Année">
          <select value={card.expYear} onChange={(e) => setCard({ ...card, expYear: e.target.value })} className="input">
            <option value="">—</option>
            {card.expYear && (Number(card.expYear) < year || Number(card.expYear) > year + 20) && <option value={card.expYear}>{card.expYear}</option>}
            {Array.from({ length: 21 }, (_, i) => String(year + i)).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <Field label="Code (CVV)">
          <PasswordInput value={card.code} onChange={(code) => setCard({ ...card, code })} autoComplete="off" />
        </Field>
      </div>
      <SecretFooter value={card} onChange={setCard} groups={index.groups} />
    </FormShell>
  );
}
