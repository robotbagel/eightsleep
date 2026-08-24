"use client";

import { useCallback, useMemo, useState } from "react";
import { apiR } from "~/trpc/react";
import { EightLoginDialog } from "~/components/eightLogin";
import { TemperatureProfileForm } from "~/components/temperatureProfileForm";
import { LogoutButton } from "~/components/logout";
import { ThemeToggle } from "~/components/themeToggle";
import { AiAdvisorCard, AiSettingsCard } from "~/components/aiPanel";
import { NightSummaryCard } from "~/components/nightSummaryCard";
import { NightTimeline } from "~/components/nightTimeline";
import { CompareCard } from "~/components/compareCard";
import { OutlookCard } from "~/components/outlookCard";
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
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div
          className="space-y-4 lg:col-span-2"
          style={{ touchAction: "pan-y" }}
          {...swipe.bind}
        >
          <div
            className={
              swipe.entering === "prev"
                ? "enter-prev space-y-4"
                : swipe.entering === "next"
                  ? "enter-next space-y-4"
                  : "space-y-4"
            }
            style={{
              transform: swipe.dx !== 0 ? `translateX(${swipe.dx}px)` : undefined,
              transition: swipe.dragging
                ? "none"
                : "transform var(--motion-base) cubic-bezier(0.2, 0.9, 0.3, 1)",
            }}
          >
            <NightSummaryCard night={selectedNight} nav={nav} index={0} />
            <NightTimeline
              displayUnit={displayUnit}
              night={selectedNight}
              index={1}
            />
          </div>
        </div>

        {/* Where the night sits in the run: last two nights measured, tonight
            predicted. Outside the swipe container on purpose — it is about the
            trend, not the night you happen to be paging through. */}
        <div className="lg:col-span-2">
          <OutlookCard index={2} />
        </div>

        <CompareCard index={3} />
        <AiAdvisorCard displayUnit={displayUnit} index={4} />

        <div className="space-y-4 lg:col-span-2">
          <Disclosure
            icon="bed"
            title="Tonight's schedule"
            summary="Bed time, wake-up, and the four stage temperatures."
            index={5}
          >
            <TemperatureProfileForm />
          </Disclosure>

          <AiSettingsCard index={6} />
        </div>
      </div>
    </div>
  );
};
