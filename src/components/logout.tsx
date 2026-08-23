"use client";
import React from "react";
import { apiR } from "~/trpc/react";
import LordIcon from "./ui/lordIcon";

export const LogoutButton: React.FC<{ onLogoutSuccess: () => void }> = ({
  onLogoutSuccess,
}) => {
  const logoutMutation = apiR.user.logout.useMutation({
    onSuccess: onLogoutSuccess,
  });

  return (
    <button
      id="logout"
      type="button"
      onClick={() => logoutMutation.mutate()}
      disabled={logoutMutation.isPending}
      className="btn btn-ghost"
      aria-label="Sign out"
      title={logoutMutation.isError ? logoutMutation.error.message : "Sign out"}
    >
      <LordIcon
        name="logout"
        size={20}
        trigger="hover"
        target="#logout"
        color="var(--text-muted)"
      />
    </button>
  );
};
