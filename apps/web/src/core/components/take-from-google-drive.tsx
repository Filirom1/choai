import type { JSX } from "solid-js"
import { useMoves } from "~/core/address/moves"

import { Button } from "~/core/components/ui/button"
import { ADD_FROM_GOOGLE_DRIVE } from "~/core/address/address"
import { t } from "~/core/i18n"

export function TakeFromGoogleDrive(): JSX.Element {
  const moves = useMoves()

  return (
    <section class="flex w-full flex-col items-start gap-2 border-t border-border pt-4">
      <Button variant="outline" onClick={() => moves.goTo(ADD_FROM_GOOGLE_DRIVE)}>
        {t("books.fromGoogleDrive")}
      </Button>
    </section>
  )
}
