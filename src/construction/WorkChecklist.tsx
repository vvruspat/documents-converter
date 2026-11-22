import { Check, Circle } from 'lucide-react';
import type { CheckItem } from '../../shared/readiness';
import s from './projects.module.css';
export function WorkChecklist({ items }: { items: CheckItem[] }) {
  return (
    <div className={s.workChecks}>
      {(['work', 'evidence'] as const).map((section) => {
        const checks = items.filter((c) => c.section === section);
        if (!checks.length) return null;
        const title = section === 'work' ? 'Этап работ' : 'Подтверждающие документы';
        return (
          <div key={section}>
            <span className={s.checkHeading}>{title}</span>
            <ul aria-label={title}>
              {checks.map((item, i) => (
                <li key={i} data-present={item.present} title={item.detail}>
                  {item.present ? <Check aria-hidden="true" size={15} /> : <Circle aria-hidden="true" size={12} />}
                  <span className="visually-hidden">{item.present ? 'Есть · ' : 'Нет · '}</span>
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
