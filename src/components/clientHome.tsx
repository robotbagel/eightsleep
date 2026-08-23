"use client";

import { useState } from "react";
import { apiR } from "~/trpc/react";
import { EightLoginDialog } from "~/components/eightLogin";
import { TemperatureProfileForm } from "~/components/temperatureProfileForm";
import { LogoutButton } from "~/components/logout";
import { ThemeToggle } from "~/components/themeToggle";
import { AiAdvisorCard, AiSettingsCard } from "~/components/aiPanel";
import { LastNightCard } from "~/components/lastNightCard";
import { NightTimeline } from "~/components/nightTimeline";
import { TrendsCard } from "~/components/trendsCard";
import { Disclosure } from "~/components/ui/card";
import LordIcon from "~/components/ui/lordIcon";
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

  return (
    <div className="mx-auto max-w-5xl px-4 pt-5">
      {/* The data first: last night, then the night itself, then the trend.
          Everything you configure lives below, folded away. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          <LastNightCard index={0} />
          <NightTimeline displayUnit={displayUnit} index={1} />
        </div>

        <TrendsCard index={2} />
        <AiAdvisorCard displayUnit={displayUnit} index={3} />

        <div className="space-y-4 lg:col-span-2">
          <Disclosure
            icon="bed"
            title="Tonight's schedule"
            summary="Bed time, wake-up, and the four stage temperatures."
            index={4}
          >
            <TemperatureProfileForm />
          </Disclosure>

          <AiSettingsCard index={5} />
        </div>
      </div>
    </div>
  );
};
