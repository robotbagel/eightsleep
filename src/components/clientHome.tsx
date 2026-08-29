"use client";

import { useCallback, useMemo, useState } from "react";
import { apiR } from "~/trpc/react";
import { EightLoginDialog } from "~/components/eightLogin";
import { TemperatureProfileForm } from "~/components/temperatureProfileForm";
import { LogoutButton } from "~/components/logout";
import { ThemeToggle } from "~/components/themeToggle";
import { AiAdvisorCard, AiSettingsCard } from "~/components/aiPanel";
import { NightSummaryCard } from "~/components/nightSummaryCard";
import { AutopilotStrip } from "~/components/autopilotStrip";
import { ComfortPrompt } from "~/components/comfortPrompt";
import { TrendsCard } from "~/components/trendsCard";
import { Disclosure } from "~/components/ui/card";
import LordIcon from "~/components/ui/lordIcon";
import { useSwipe } from "~/components/useSwipe";
import { type DisplayUnit } from "~/lib/temperature";

export default function ClientHome({
  initialLoginState,
}: {
  initialLoginState: boolean;
}) {
  const [isLoggedIn, setIsLoggedIn] = useState(initialLoginState);

  return (
    <main className="min-h-screen pb-16">
      <Header showAccount={isLoggedIn} onLogout={() => setIsLoggedIn(false)} />

      {isLoggedIn ? (
        <SignedIn />
      ) : (
        <div className="mx-auto max-w-2xl px-4 pt-16">
          <EightLoginDialog onLoginSuccess={() => setIsLoggedIn(true)} />
        </div>
      )}
    </main>
  );
}

const Header: React.FC<{ showAccount: boolean; onLogout: () => void }> = ({
  showAccount,
  onLogout,
}) => (
  <header
    className="sticky top-0 z-30 border-b backdrop-blur"
    style={{
      borderColor: "var(--border)",
      backgroundColor: "color-mix(in srgb, var(--bg) 82%, transparent)",
    }}
  >
    <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
      <span id="brand" className="flex items-center gap-2">
        <LordIcon
          name="moon"
          size={22}
          trigger="hover"
          target="#brand"
          color="var(--accent)"
          colorSecondary="var(--text-muted)"
        />
        <span
          className="text-base font-semibold tracking-tight"
          style={{ color: "var(--text-headline)" }}
        >
          Sleep
        </span>
      </span>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        {showAccount && <LogoutButton onLogoutSuccess={onLogout} />}
      </div>
    </div>
  </header>
);

const SignedIn: React.FC = () => {
  // One shared read of the settings so every card speaks the same unit.
  const settingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const displayUnit: DisplayUnit =
    settingsQuery.data?.displayUnit === "level" ? "level" : "celsius";

  // `null` means "whatever the newest night is" — so the page keeps following
  // the latest night until you deliberately step back.
  const [selectedNight, setSelectedNight] = useState<string | null>(null);
  // The autopilot's reasoning is a level-3 answer: on the surface it is one
  // line, and only opens when asked. See ia-contract.json.
  const [autopilotOpen, setAutopilotOpen] = useState(false);

  const nightQuery = apiR.user.getNightTimeline.useQuery(
    selectedNight ? { night: selectedNight } : undefined,
    { refetchOnWindowFocus: false },
  );

  const nights = useMemo(
    () => nightQuery.data?.availableNights ?? [],
    [nightQuery.data?.availableNights],
  );
  const currentNight = selectedNight ?? nightQuery.data?.night ?? null;
  const position = currentNight ? nights.indexOf(currentNight) : -1;
  const canPrev = position > 0;
  const canNext = position >= 0 && position < nights.length - 1;
  const isLatest =
    currentNight != null && nights.length > 0
      ? currentNight === nights[nights.length - 1]
      : selectedNight == null;

  const goPrev = useCallback(() => {
    if (position > 0) setSelectedNight(nights[position - 1]!);
  }, [nights, position]);
  const goNext = useCallback(() => {
    if (position >= 0 && position < nights.length - 1) {
      setSelectedNight(nights[position + 1]!);
    }
  }, [nights, position]);
  const goLatest = useCallback(() => setSelectedNight(null), []);

  const swipe = useSwipe({
    onPrev: goPrev,
    onNext: goNext,
    canPrev,
    canNext,
  });

  const nav = {
    night: currentNight,
    isLatest,
    canPrev,
    canNext,
    onPrev: goPrev,
    onNext: goNext,
    onLatest: goLatest,
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pt-5">
      {/* The data first: the selected night, then how it compares, then the
          plan. Everything you configure lives below, folded away. */}
      {/* Level 1: how did I sleep, and what is being done about it. Nothing
          else competes with these two above the fold. */}
      <div className="space-y-4">
        <div
          className="min-w-0"
          style={{ touchAction: "pan-y" }}
          {...swipe.bind}
        >
          <div
            className={
              swipe.entering === "prev"
                ? "enter-prev min-w-0"
                : swipe.entering === "next"
                  ? "enter-next min-w-0"
                  : "min-w-0"
            }
            style={{
              transform: swipe.dx !== 0 ? `translateX(${swipe.dx}px)` : undefined,
              transition: swipe.dragging
                ? "none"
                : "transform var(--motion-base) cubic-bezier(0.2, 0.9, 0.3, 1)",
            }}
          >
            <NightSummaryCard night={selectedNight} nav={nav} index={0} />
          </div>
        </div>

        {/* Asked once each morning, gone once answered. It sits directly under
            the night it is about. */}
        <ComfortPrompt index={1} />

        <AutopilotStrip
          displayUnit={displayUnit}
          expanded={autopilotOpen}
          onOpen={() => setAutopilotOpen((open) => !open)}
        />

        <div
          className="grid transition-[grid-template-rows] duration-base ease-snap"
          style={{ gridTemplateRows: autopilotOpen ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            {autopilotOpen && (
              <AiAdvisorCard displayUnit={displayUnit} index={0} />
            )}
          </div>
        </div>

        {/* Level 2: the same night and the same history, one view at a time. */}
        <TrendsCard
          displayUnit={displayUnit}
          night={selectedNight}
          index={2}
        />

        {/* Level 4: everything you configure, folded away. */}
        <Disclosure
          icon="bed"
          title="Tonight's schedule"
          summary="Bed time, wake-up, and the four stage temperatures."
          index={3}
        >
          <TemperatureProfileForm />
        </Disclosure>

        <AiSettingsCard index={4} />
      </div>
    </div>
  );
};
