import { Menu, MenuCheckboxItem, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@basedraft/ui';
import { FunnelSimpleIcon, XIcon } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { count } from '../lib/library';
import { Tip } from './Tip';

export type FilterOption = { value: string; label: string; icon: ReactNode; count: number };
export type FilterGroup = { label: string; options: FilterOption[] };

/**
 * One button beside the search field. It opens a menu of what to narrow to, in groups (the folders
 * inside this one, shape, kind, format), each with its icon and how many it would leave. Tick as
 * many as you like: the menu stays open, and the button shows how many are on.
 */
export function FilterMenu({ groups, value, onValueChange }: { groups: FilterGroup[]; value: string[]; onValueChange: (value: string[]) => void }) {
  const on = value.length;
  const shown = groups.filter((g) => g.options.length > 0);
  const flip = (v: string, checked: boolean) => onValueChange(checked ? [...value, v] : value.filter((x) => x !== v));
  const name = on ? `Filter, ${on} on` : 'Filter';
  return (
    <Menu>
      <Tip content={on ? `${on} ${on === 1 ? 'filter' : 'filters'} on` : 'Filter'}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={name}
            data-filter
            disabled={!shown.length}
            className={`relative grid size-[44px] shrink-0 place-items-center rounded-[12px] border outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ink/40 disabled:opacity-40 ${
              on ? 'border-ink/[0.2] bg-ink/[0.08] text-ink' : 'border-ink/[0.08] bg-ink/[0.025] text-ink/55 hover:bg-ink/[0.05] hover:text-ink'
            }`}
          >
            <FunnelSimpleIcon weight={on ? 'bold' : 'regular'} className="size-[18px]" />
            <AnimatePresence initial={false}>
              {on > 0 && (
                <motion.span
                  key="on"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 640, damping: 32 }}
                  className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[11px] font-semibold tabular-nums text-panel"
                >
                  {on}
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end" className="scroll-thin max-h-[min(480px,70vh)] w-[272px] overflow-y-auto">
        {shown.map((g, k) => (
          <MenuGroup key={g.label} label={g.label}>
            {k > 0 && <MenuSeparator />}
            <MenuLabel>{g.label}</MenuLabel>
            {g.options.map((o) => (
              <MenuCheckboxItem key={o.value} checked={value.includes(o.value)} onCheckedChange={(c) => flip(o.value, c)}>
                <span className="flex items-center gap-2.5">
                  <span aria-hidden className="grid shrink-0 place-items-center text-ink/55">
                    {o.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-ink/35">{count(o.count)}</span>
                </span>
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
        ))}
        {on > 0 && (
          <>
            <MenuSeparator />
            <MenuItem icon={<XIcon />} onSelect={() => onValueChange([])}>
              Clear Filters
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
