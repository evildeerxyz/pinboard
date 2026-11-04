import { Button, Segmented, Switch, toast } from '@basedraft/ui';
import { CheckCircleIcon, EyeSlashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, type ReactNode } from 'react';
import { isDefaultViewer, openPrivacySettings, setDefaultViewer } from '../lib/api';
import { count, sizeOf } from '../lib/library';
import type { Settings } from '../lib/settings';

/**
 * Everything you can change, in one quiet page: what goes in the library, how the grid and the
 * viewer look, when it looks for new pictures, the thumbnail cache, and folder access.
 */
export function SettingsPage({
  settings,
  update,
  reset,
  pictures,
  folders,
  blocked,
  scannedAt,
  appName,
  onRescan,
}: {
  settings: Settings;
  update: (patch: Partial<Settings> | ((now: Settings) => Partial<Settings>)) => void;
  reset: () => void;
  pictures: number;
  folders: number;
  blocked: string[];
  scannedAt: number;
  appName: string;
  onRescan: () => void;
}) {
  const [cache, setCache] = useState<number | null>(null);
  const measure = () => void invoke<number>('cache_size').then(setCache).catch(() => setCache(null));
  useEffect(measure, []);
  /** Whether pictures open in Pinboard from Finder (null until macOS says, or while it's changing). */
  const [finder, setFinder] = useState<boolean | null>(null);
  const checkFinder = () => void isDefaultViewer().then((on) => setFinder(!!on)).catch(() => setFinder(false));
  useEffect(checkFinder, []);
  const changeFinder = (on: boolean) => {
    setFinder(null);
    void setDefaultViewer(on)
      .then(() => toast(on ? 'Pictures open in Pinboard now' : 'Pictures open in Preview again', { description: on ? 'Double-click one in Finder to try it.' : undefined, tone: 'ok', duration: 2600 }))
      .catch((e) => toast("Couldn't change it", { description: String(e), tone: 'stop' }))
      .finally(checkFinder);
  };

  const scanChange = (patch: Partial<Settings>) => {
    update(patch);
    // These change what the scan keeps, so look again once the change is in.
    setTimeout(onRescan, 50);
  };

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 pb-10">
      <Section title="Library" note="What Pinboard shows. It looks in your home folder with Spotlight, so nothing is copied and nothing leaves your Mac.">
        <Row title="Leave out code projects" detail="Developer, and any folder with a project in it (package.json, .git, Cargo.toml…). Their icons and assets aren't your pictures.">
          <Switch checked={settings.skipCode} onCheckedChange={(v) => scanChange({ skipCode: v })} aria-label="Leave out code projects" />
        </Row>
        <Row title="Leave out small images" detail="Icons, stickers and UI bits smaller than about 240 pixels. Screenshots are kept down to 160.">
          <Switch checked={settings.skipSmall} onCheckedChange={(v) => scanChange({ skipSmall: v })} aria-label="Leave out small images" />
        </Row>
        <Row title="Video frames in All Photos" detail="Folders of numbered frames always have their own Video Frames view. Turn this on to see them in All Photos too.">
          <Switch checked={settings.framesInAll} onCheckedChange={(v) => update({ framesInAll: v })} aria-label="Video frames in All Photos" />
        </Row>
        <Row
          title="Hidden folders"
          detail={settings.hidden.length ? 'Right-click a folder in the sidebar to hide more.' : 'None. Right-click a folder in the sidebar to hide it from Pinboard.'}
          stacked={settings.hidden.length > 0}
        >
          {settings.hidden.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {settings.hidden.map((f) => (
                <div key={f} className="flex items-center gap-3 rounded-[10px] bg-white/[0.035] px-3 py-2">
                  <EyeSlashIcon className="size-4 shrink-0 text-white/40" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-white/80">{f.replaceAll('/', ' / ')}</span>
                  <Button size="sm" variant="ghost" onClick={() => update({ hidden: settings.hidden.filter((h) => h !== f) })}>
                    Show Again
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Row>
      </Section>

      <Section title="Grid">
        <Row title="Card size" detail="How wide the photos are. Bigger cards, fewer columns.">
          <Segmented
            label="Card size"
            size="sm"
            value={settings.cardSize}
            onValueChange={(v) => update({ cardSize: v as Settings['cardSize'] })}
            options={[
              { value: 's', label: 'Small' },
              { value: 'm', label: 'Medium' },
              { value: 'l', label: 'Large' },
            ]}
          />
        </Row>
        <Row title="Like and Show on cards" detail="The two buttons that appear when you point at a photo. Right-click still has everything.">
          <Switch checked={settings.hoverActions} onCheckedChange={(v) => update({ hoverActions: v })} aria-label="Like and Show on cards" />
        </Row>
      </Section>

      <Section title="Viewer">
        <Row
          title="Open pictures from Finder in Pinboard"
          detail="Double-click a JPEG, PNG, HEIC, WebP, GIF or TIFF in Finder and it opens here, among the others in its folder, instead of in Preview. Turn it off to go back to Preview. For one picture at a time, right-click it in Finder and choose Open With › Pinboard."
        >
          <Switch checked={!!finder} disabled={finder === null} onCheckedChange={changeFinder} aria-label="Open pictures from Finder in Pinboard" />
        </Row>
        <Row title="Filmstrip" detail="The photos around the one you're looking at, along the bottom, to jump to.">
          <Switch checked={settings.filmstrip} onCheckedChange={(v) => update({ filmstrip: v })} aria-label="Filmstrip" />
        </Row>
        <Row title="Photo quality" detail="Sharp is best on a Retina screen. Fast makes each photo smaller and quicker to open.">
          <Segmented
            label="Photo quality"
            size="sm"
            value={settings.quality}
            onValueChange={(v) => update({ quality: v as Settings['quality'] })}
            options={[
              { value: 'fast', label: 'Fast' },
              { value: 'sharp', label: 'Sharp' },
            ]}
          />
        </Row>
      </Section>

      <Section title="Updates">
        <Row title="Look for new pictures" detail={`Last looked ${scannedAt ? new Date(scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never'}. It takes about two seconds and doesn't read your files.`}>
          <Segmented
            label="Look for new pictures"
            size="sm"
            value={settings.rescan}
            onValueChange={(v) => update({ rescan: v as Settings['rescan'] })}
            options={[
              { value: 'return', label: 'When I come back' },
              { value: 'hourly', label: 'Hourly' },
              { value: 'manual', label: 'Only when I ask' },
            ]}
          />
        </Row>
        <Row title="Look now" detail={`${count(pictures)} pictures in ${count(folders)} folders.`}>
          <Button size="sm" variant="outline" onClick={onRescan}>
            Look Again
          </Button>
        </Row>
      </Section>

      <Section title="Storage">
        <Row title="Thumbnails" detail={`Small copies made as photos come into view, kept so they open instantly. ${cache === null ? '' : `They take ${sizeOf(cache)}.`}`}>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void invoke('clear_cache')
                .then(() => {
                  measure();
                  toast('Thumbnails cleared', { description: 'They come back as you scroll.', tone: 'ok', duration: 2400 });
                })
                .catch((e) => toast("Couldn't clear them", { description: String(e), tone: 'stop' }))
            }
          >
            Clear
          </Button>
        </Row>
      </Section>

      <Section title="Privacy" note="macOS asks before any app looks in Downloads, Desktop or Documents.">
        {['Downloads', 'Desktop', 'Documents'].map((f) => {
          const no = blocked.includes(f);
          return (
            <Row
              key={f}
              title={f}
              detail={no ? `${appName} isn't allowed to look here, so its pictures are missing.` : `${appName} can see the pictures here.`}
              icon={no ? <WarningCircleIcon weight="fill" className="size-[18px] text-[#f5a524]" /> : <CheckCircleIcon weight="fill" className="size-[18px] text-[#3ec46d]" />}
            >
              {no && (
                <Button size="sm" variant="outline" onClick={() => void openPrivacySettings()}>
                  Allow…
                </Button>
              )}
            </Row>
          );
        })}
      </Section>

      <Section title="About">
        <Row title={appName} detail="Every picture on your Mac, in one place. Made with basedraft UI.">
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset Settings
          </Button>
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="px-1 pb-2 text-[13px] font-semibold text-white/55">{title}</h2>
      <div className="divide-y divide-white/[0.06] overflow-hidden rounded-[14px] border border-white/[0.07] bg-white/[0.025]">{children}</div>
      {note && <p className="px-1 pt-2 text-[12.5px] leading-relaxed text-white/35">{note}</p>}
    </section>
  );
}

function Row({ title, detail, icon, stacked, children }: { title: string; detail?: string; icon?: ReactNode; stacked?: boolean; children?: ReactNode }) {
  return (
    <div className={`flex gap-4 px-4 py-3.5 ${stacked ? 'flex-col' : 'items-center'}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon && <span className="mt-[1px] shrink-0">{icon}</span>}
        <div className="min-w-0">
          <p className="text-[14.5px] text-white/90">{title}</p>
          {detail && <p className="mt-0.5 text-[12.5px] leading-relaxed text-white/45">{detail}</p>}
        </div>
      </div>
      {children && <div className={stacked ? '' : 'shrink-0'}>{children}</div>}
    </div>
  );
}
