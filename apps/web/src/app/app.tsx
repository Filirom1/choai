import type { Accessor, JSX, ParentProps } from "solid-js"
import { Show, createEffect, createResource, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Dynamic } from "solid-js/web"
import { getOrUndefined } from "~/core/lib/monad"

import { ActivityBar, AuxPanel, Shell, SidePanel, TitlesBar, type ActivityItem } from "~/core/lib/solid-workbench-shell"
import { Tooltip, TooltipContent, TooltipTrigger } from "~/core/components/ui/tooltip"
import { Button } from "~/core/components/ui/button"
import { TroubleNote } from "~/core/components/trouble-note"
import { SnagNote as GitHubSnagNote } from "~/core/components/github-panel"
import { DriveSnag } from "~/core/components/google-drive-panel"
import { localFailureWords } from "~/core/components/local-sync-panel"
import { githubResolutionFailure, SyncResolutionPanel } from "~/core/components/sync-resolution-panel"
import { ChevronLeftIcon, RefreshIcon, PanelLeftIcon, ImportIcon, CloudIcon, PlusIcon } from "~/core/lib/ui/icons"
import { focusOf, unfocused, without } from "~/core/journal/terms"
import { readQuery } from "~/core/reports/reading"
import { AccountLedger } from "~/core/components/account-ledger"
import { ledgerHasAPlace, statementAt } from "~/core/routes/reports"
import { ADD, FOOT, NAV, railOf, viewAt } from "./views"
import type { View } from "~/edition/types"
import { appName } from "~/edition"
import { changedOnDisk, journal, localFolderHasPending, reloadLocalFolder, reopenKept, saveToLocalFolder, type LocalTrouble } from "~/core/journal/store"
import { isGitHubRemote, isGoogleDriveRemote } from "~/core/journal/remote"
import { agreements as githubAgreements, token as githubToken } from "~/core/github/kept"
import { exportBinaryResolution as exportGitHub, inspect as inspectGitHub, pull as githubPull, push as githubPush, resolve as resolveGitHub, unsent as githubUnsent, type Snag as GitHubSnag, type ResolutionFailure as GitHubResolutionFailure } from "~/core/github/sync"
import type { FileSnapshot } from "~/core/sync/conflict"
import { forgetResolution, resolutionsFor } from "~/core/sync/kept"
import { remoteReviewRequest } from "~/core/sync/review-request"
import {
  noteRemoteChangePaths,
  noteRemoteChangeSnapshots,
  noteRemoteChangesChecking,
  noteRemoteChangesUnavailable,
  remoteChangesNow,
} from "~/core/sync/remote-changes"
import { agreementRevision as driveAgreementRevision, checkRevision as driveCheckRevision, clientId as driveClientId, clientIdNow as driveClientIdNow, keepClientId as keepDriveClientId, noteDriveChecked } from "~/core/google-drive/kept"
import { accessToken as driveAccessToken, loadIdentity as loadDriveIdentity, sessionToken as driveSessionToken } from "~/core/google-drive/auth"
import { behind as driveBehind, exportBinaryResolution as exportDrive, inspectResolution as inspectDrive, pull as drivePull, push as drivePush, resolveResolution as resolveDrive, unsent as driveUnsent, type Snag as DriveTrouble, type ResolutionFailure as DriveResolutionFailure } from "~/core/google-drive"
import { exportLocalResolution, inspectLocalResolution, resolveLocalResolution, type LocalResolutionFailure } from "~/core/journal/local-resolution"
import { permitLocalFolder } from "~/core/journal/local"
import { behindNow, refreshBehind } from "~/core/components/git/kept-in-view"
import { searchFor, useQuery } from "~/core/journal/query"
import { JevKeyPanel } from "~/core/components/jev-key-panel"
import { AiImportPanel } from "~/core/components/ai-import-panel"
import { CsvImportPanel } from "~/core/components/csv-import-panel"
import { ProposalReview } from "~/core/components/proposal-review"
import { createRenewal } from "~/core/lib/renewal"
import { QueryBox } from "~/core/components/query-box"
import { underReview } from "~/core/journal/proposals"
import { showed, wantedQuery } from "~/core/journal/showing"
import { ComposePanel } from "~/core/compose/ComposePanel"
import { EntryEditor } from "~/core/compose/EntryEditor"
import { editing, stopEditingEntry } from "~/core/compose/editing"
import { LAYER_OF, dock, dockedAs, seatDock, type InTheDock } from "~/core/dock"
import { JOURNAL, REMOTES, appPath, atTheList, atTheWork, dockedIn, readFragment, showsTheWork, withLayer } from "~/core/address/address"
import { useMoves } from "~/core/address/moves"
import { addressOf, lookingAt } from "~/core/components/git/looking"
import { narrow, overHalf, viewportWidth } from "~/core/lib/narrow"
import { actionFor } from "~/core/lib/shortcuts"
import { ShortcutsHelp } from "~/core/components/shortcuts-help"
import { BookSwitcher } from "~/core/components/book-switcher"
import { BackupButton } from "~/core/components/backup-button"
import { t } from "~/core/i18n"

/** What the dock is called, by what is in it. */
const dockTitle = (showing: InTheDock | undefined): string => {
  switch (showing) {
    case "editing":
      return t("edit.title")
    case "reviewing":
      return t("propose.title")
    case "importing":
      return t("receipts.title")
    case "csv-importing":
      return t("csvImport.title")
    case "connecting":
      return t("ai.connection")
    case "ledger":
      return t("ledger.title")
    case "composing":
    case undefined:
      return t("compose.title")
  }
}

/**
 * The one place a panel's width is animated.
 *
 * The shell leaves this to whoever uses it, since a neighbour that redraws — a
 * canvas, a map — would flicker for the length of the slide. Nothing here does,
 * so both panels get the same short slide, and anyone who has asked for less
 * motion gets none.
 */
const SLIDE = "transition-[width] duration-150 ease-out motion-reduce:transition-none"

/**
 * No panel may be wider than the window.
 *
 * A panel that overflows has its far edge, and whatever sits on it, pushed off
 * screen — for the composer that is the button which closes it, leaving no way
 * back. Given as a function so it follows a window being resized.
 *
 * One pixel short of the window, because a panel lays out its splitter beside
 * itself and that line has to land somewhere.
 */
const withinWindow = (): number => Math.max(1, viewportWidth() - 1)

/**
 * The rail and the explorer at rest, and the line they must not both cross.
 *
 * Written as what the two of them settle at rather than what they currently
 * measure, so that dragging the explorer past half a desktop window does not
 * snap it to the whole of one and pin it there with no way back. See `overHalf`.
 */
const RAIL = 48
const EXPLORER = 260

/** The rail's own edge, and the explorer's splitter: a line each. */
const EDGES = 2

export function Layout(props: ParentProps) {
  const location = useLocation()
  const moves = useMoves()
  const [query, setQuery] = useQuery()
  const [railExpanded, setRailExpanded] = createSignal(false)
  const [railVisible, setRailVisible] = createSignal(true)
  const [panelOpen, setPanelOpen] = createSignal(true)
  const [searchBox, setSearchBox] = createSignal<HTMLInputElement>()
  const [saveRequest, setSaveRequest] = createSignal(0)

  /**
   * The cursor into the query, with what is there already selected, so the
   * next keys either replace it or, after an arrow, add to it.
   */
  const toTheQuery = (): void => {
    searchBox()?.focus()
    searchBox()?.select()
  }

  /**
   * Whether the left of the window is a screen of its own.
   *
   * Where the rail and the explorer together would take more than half of what
   * there is, they take all of it instead and the work goes behind them —
   * because a window that narrow was never going to show both, and pretending
   * otherwise leaves the work in a column too thin to read. Nothing here asks
   * what kind of device this is.
   */
  const snapped = (): boolean => overHalf(RAIL + EXPLORER)

  /**
   * Where the list takes the window, it is a screen of its own, and the address
   * says which of the two is showing: a page's list is the page with nothing
   * after its `#`. Beside the work the list is only a panel folded or not, and
   * every fold being a step to press back through would bury the pages behind
   * them.
   */
  const listed = (): boolean => !showsTheWork(moves.fragment())
  const drawerOpen = (): boolean => snapped() && listed()
  const railShown = (): boolean => (snapped() ? listed() : railVisible())
  const panelShown = (): boolean => (snapped() ? listed() : panelOpen())
  const chromeShowing = (): boolean => railShown() || panelShown()

  const setChrome = (show: boolean): void => {
    if (snapped()) {
      show ? moves.toTheList() : moves.toTheWork()
      return
    }
    setRailVisible(show)
    setPanelOpen(show)
  }

  /** What the explorer is pinned to when it has the window to itself. */
  const wholeWindow = (): number => Math.max(1, viewportWidth() - RAIL - EDGES)
  const drawerPanelWidth = (): number =>
    Math.max(1, viewportWidth() * 0.76 - (railExpanded() ? 208 : RAIL) - EDGES)

  /**
   * The list has done its job, so the work is what to look at.
   *
   * Everything in the list that leads somewhere calls this: choosing an account,
   * and going to the text behind the journal. At any width, so that an address
   * says the same thing whichever window it is opened in; only a window too
   * narrow for both shows the difference.
   */
  const showTheWork = (): void => {
    moves.toTheWork()
  }

  /**
   * Choosing in the explorer is one change of address, not two.
   *
   * The query and the page it applies to are set together. Set one after the
   * other they are two navigations in a tick, and the router keeps only the last
   * of them, so the query would be dropped by the page that followed it.
   *
   * The page is the view the explorer belongs to, which is not always the one on
   * screen. An inner page borrows its rail's explorer — the journal's own text
   * sits under the account list and has no use for what the list sets — and
   * there, choosing did nothing at all: the query changed behind a page that
   * does not read it, and the only way out was the one small switch that led in.
   * So choosing is the way out as well.
   *
   * Leaving a page is going back to another one, so it is pushed; narrowing the
   * page already open is not going anywhere, and pushing there would make every
   * account tried a step to be pressed back through. Unless the list was what
   * the address showed: leaving it is a step, and going back should find it.
   *
   * The settings explorer chooses a section rather than a query and takes its own
   * address there, so it hands up nothing and nothing here moves.
   *
   */
  const chose = (chosen?: string): void => {
    if (chosen !== undefined) {
      const view = railOf(current())
      moves.move(
        (at) => ({ path: view, search: searchFor(chosen), fragment: atTheWork(atTheList(at.fragment)) }),
        { replace: view === appPath(location.pathname) && !listed() },
      )
      return
    }
    showTheWork()
  }

  /**
   * The title bar's button works on the chrome as a whole, both rails at once,
   * so one press clears everything away from the books and the next brings it
   * all back.
   */
  const toggleChrome = (): void => {
    setChrome(!chromeShowing())
  }

  /**
   * Selecting a view opens the explorer beside it; selecting the view already
   * shown folds the explorer away, which is what the icon rail does in the
   * editor this shell is shaped after.
   *
   * The query travels along. It belongs to the books being looked at rather than
   * to the report looking at them, so changing report must not drop it — all
   * but what the view being left wrote into it itself.
   */
  const select = async (href: string): Promise<void> => {
    if (appPath(location.pathname) === href) {
      snapped() ? moves.toTheWork() : setPanelOpen((open) => !open)
      return
    }
    setPanelOpen(true)
    const search = await searchLeaving(current())
    moves.move((at) => ({ ...at, path: href, search: search ?? at.search, fragment: atTheList(at.fragment) }))
  }

  /**
   * The query as it goes on from a view being left, without the terms that
   * view's own controls wrote. Undefined where nothing comes out, so the
   * address is left exactly as it is.
   */
  const searchLeaving = async (leaving: View): Promise<string | undefined> => {
    const owned = leaving.owns
    if (owned === undefined) return undefined
    const read = await readQuery(untrack(query))
    return read.ok && read.value.terms.some(owned) ? searchFor(without(read.value, owned)) : undefined
  }

  /**
   * Asked for once an hour and whenever the app comes back to the front, which
   * on a phone is the nearest thing there is to being started.
   */
  const renewal = createRenewal(60 * 60 * 1000)

  /**
   * A proposal takes the dock when it arrives — from an agent driving the app,
   * a script, or a screen that read something into entries — since what was
   * proposed has nowhere else to be seen.
   *
   * Nothing here puts it back once it has been closed: this runs when a
   * proposal arrives, and closing is not that.
   */
  createEffect(
    on(underReview, (proposal) => {
      if (proposal !== undefined && !dock.is("reviewing")) dock.show("reviewing")
    }),
  )

  /**
   * The dock is lent through the address, so going back puts it down and going
   * forward lends it again.
   *
   * On a narrow window lending it folds the rails away first. There is not room
   * for both, and this reuses the folding already here rather than bringing in
   * a second kind of container for small screens. Whoever asked for it — the
   * journal opening an entry knows nothing of the rails — gets the room either
   * way.
   */
  seatDock({
    showing: () => dockedAs(dockedIn(readFragment(location.hash))),
    show: (what) => {
      if (narrow() && !snapped()) {
        setRailVisible(false)
        setPanelOpen(false)
      }
      moves.move((at) => ({
        ...at,
        fragment: withLayer(narrow() ? atTheWork(at.fragment) : at.fragment, LAYER_OF[what]),
      }))
    },
    close: () => {
      const showing = dock.showing()
      if (showing === "ledger") void putTheLedgerDown()
      else if (showing !== undefined) moves.lift(LAYER_OF[showing])
    },
  })

  /**
   * The ledger is the query's `inacct:`, so putting it down takes that out of
   * the query and leaves the rest: a title bar still naming an account would
   * describe a ledger nobody can see. Where the ledger was opened from the
   * query as it is now, that is the step back it looks like.
   */
  const putTheLedgerDown = async (): Promise<void> => {
    const read = await readQuery(untrack(query))
    if (!read.ok) return moves.lift(LAYER_OF.ledger)
    const search = searchFor(unfocused(read.value))
    moves.lift(LAYER_OF.ledger, (at) => ({ ...at, search }))
  }

  /**
   * An occupant with nothing to show gives the space back.
   *
   * Reached by going forward to an entry whose editor has since let go, or by a
   * reload: the address still lends the dock, and what it was lent to is gone.
   * An empty panel over the journal is the one thing the dock must never be.
   */
  createEffect(() => {
    const showing = dock.showing()
    const empty =
      (showing === "editing" && editing() === undefined) ||
      (showing === "reviewing" && underReview() === undefined) ||
      (showing === "ledger" && !ledgerHasAPlace(appPath(location.pathname)))
    if (empty) dock.close()
  })

  /**
   * The entry being corrected is let go of when the dock stops showing it.
   *
   * It is held as a file and a range of lines, which is the most dangerous thing
   * to keep past the moment it is on screen: those lines go on meaning something
   * while nobody is looking at them. None of the others is a claim about where
   * in a file something sits, so none of them needs this.
   */
  createEffect(
    on(dock.showing, (showing) => {
      if (showing !== "editing" && editing() !== undefined) stopEditingEntry()
    }),
  )

  /**
   * The key's panel is reached only from AI import, so putting it down is a
   * step back to AI import — the address already makes it one — and its button
   * says so rather than showing a ✕ that does not close anything.
   */
  const steppingBack = (): boolean => dock.is("connecting")

  /**
   * The AI button puts the whole of AI away, the key's panel included. Putting
   * that panel down is a step back to AI import, so from there it is two steps
   * back instead — to where AI import was opened from, so that going back after
   * it does not open anything again.
   */
  const putAI = (): void => {
    if (dock.is("connecting")) moves.liftThrough(LAYER_OF.connecting, LAYER_OF.importing)
    else putDown()
  }

  /** Whoever has the dock gives it back. Not cleared — closed. */
  const putDown = (): void => {
    dock.close()
  }

  const compose = (): void => {
    dock.show("composing")
  }

  const importing = (): void => {
    dock.show("importing")
  }

  /**
   * A query asked for from outside the tree lands here.
   *
   * The title bar's query is in the URL, which takes a router hook, which takes
   * being inside the tree — and a capability answering a question is not. So it
   * is left in a signal and picked up here, and cleared once it has been acted
   * on so that asking for it again is a second request.
   */
  createEffect(
    on(wantedQuery, (query) => {
      if (query === undefined) return
      setQuery(query)
      showed()
    }),
  )

  /**
   * The tab is named after the books in it.
   *
   * Two sets of books open in two tabs are otherwise the same word twice, and
   * an installed app puts this in its window as well — which is the one place
   * the switcher cannot be seen.
   */
  createEffect(() => {
    const open = getOrUndefined(journal())
    document.title = open === undefined ? appName() : `${open.source.label} — ${appName()}`
  })

  onMount(() => {
    void reopenKept()

    const onKey = (event: KeyboardEvent): void => {
      const action = actionFor(event)
      if (action === undefined) return
      event.preventDefault()
      if (action === "search") toTheQuery()
      if (action === "compose") dock.is("composing") ? dock.close() : compose()
      if (action === "import") dock.is("importing") || dock.is("connecting") ? putAI() : importing()
      if (action === "save") setSaveRequest((request) => request + 1)
      if (action === "togglePanels") toggleChrome()
      if (action === "close") putDown()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  /**
   * Enter in the query where nothing on screen reads it takes the query to the
   * journal's entries; where something does, it has been answering all along,
   * and beside the statements Enter opens the ledger the query focuses on.
   */
  const queryEntered = async (asked: string): Promise<void> => {
    if (current().queried !== true) {
      moves.move((at) => ({ path: JOURNAL, search: searchFor(asked), fragment: atTheWork(atTheList(at.fragment)) }))
      return
    }
    if (!ledgerHasAPlace(appPath(location.pathname))) return
    const read = await readQuery(asked)
    if (read.ok && focusOf(read.value) !== undefined) dock.show("ledger")
  }

  /** Whether the journal's own text is what is on screen. */

  /** The view being shown, which is what the explorer beside it belongs to. */
  const current = (): View => viewAt(appPath(location.pathname))
  const explorerKey = (): string => {
    const book = getOrUndefined(journal())
    return `${current().href}:${book?.bookId ?? ""}:${JSON.stringify(book?.remote)}:${book?.local?.handle.name ?? ""}`
  }

  /**
   * The heading a rail button sits under, where it says it has one.
   *
   * Read at the moment the rail is drawn, so it follows the language the same
   * way the label does. Omitted rather than set to nothing when there is none,
   * since the rail draws a heading wherever the group changes and an empty
   * string is a change.
   */
  const groupOf = (entry: View): { group?: string } =>
    entry.reached.from === "rail" && entry.reached.group !== undefined
      ? { group: entry.reached.group() }
      : {}

  const buttonsFor = (entries: readonly View[]): ActivityItem[] =>
    entries.map((entry) => ({
      id: entry.href,
      label: entry.label(),
      icon: <entry.Icon class="h-5 w-5" />,
      active: railOf(current()) === entry.href,
      attention: entry.attention?.() === true,
      onSelect: () => void select(entry.href),
      ...groupOf(entry),
    }))

  return (
    <>
      <Show when={renewal.prompting()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="renew-title" aria-describedby="renew-message">
          <div class="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg">
            <h2 id="renew-title" class="text-lg font-semibold">{t("app.renewTitle")}</h2>
            <p id="renew-message" class="mt-2 text-sm text-muted-foreground">{t("app.renewMessage")}</p>
            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={renewal.dismiss}>{t("app.renewLater")}</Button>
              <Button onClick={renewal.take}>{t("app.renewNow")}</Button>
            </div>
          </div>
        </div>
      </Show>
      <Shell
        titles={
          <TitlesBar
            left={
              <>
                <button
                  type="button"
                  onClick={toggleChrome}
                  aria-label={chromeShowing() ? t("nav.hidePanels") : t("nav.showPanels")}
                  title={chromeShowing() ? t("nav.hidePanels") : t("nav.showPanels")}
                  class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-[900px]:size-11"
                >
                  <PanelLeftIcon class="h-4 w-4" />
                </button>
                {/* Whose books these are matters more than the app's own name,
                    and on a phone there is only room for one of them. */}
                <BookSwitcher
                  onAdd={() => moves.move((at) => ({ ...at, path: ADD, fragment: atTheWork(atTheList(at.fragment)) }))}
                  onSwitched={(kind) => {
                    // The query belonged to the books being put down; an account
                    // it names may not exist in the ones being picked up.
                    setQuery("")
                    if (kind === "book") moves.toTheJournal()
                  }}
                />
              </>
            }
            center={
              // One query for whichever report is open, the way the hledger
              // command line takes one.
              <Show when={getOrUndefined(journal())}>
                <QueryBox box={setSearchBox} onEntered={(asked) => void queryEntered(asked)} />
              </Show>
            }
            right={
              <>
                <Show when={getOrUndefined(journal()) !== undefined && current().writes}>
                  <button
                    type="button"
                    onClick={() => dock.show("composing")}
                    aria-label={t("compose.open")}
                    title={t("compose.open")}
                    class="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <PlusIcon class="h-4 w-4" />
                  </button>
                </Show>
                {/* Ahead of everything else, and only ever there when there is
                    something to take: a newer version standing by. */}
                <Show when={renewal.waiting()}>
                  <button
                    type="button"
                    onClick={renewal.take}
                    aria-label={t("app.renew")}
                    title={t("app.renew")}
                    class="inline-flex size-6 items-center justify-center rounded text-primary transition-colors hover:bg-accent"
                  >
                    <RefreshIcon class="h-4 w-4" />
                  </button>
                </Show>
                <Show when={getOrUndefined(journal()) !== undefined}>
                  <button
                    type="button"
                    onClick={() => (dock.is("importing") || dock.is("connecting") ? putAI() : importing())}
                    aria-label={t("receipts.title")}
                    title={t("receipts.title")}
                    class="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    classList={{ "bg-accent text-foreground": dock.is("importing") || dock.is("connecting") }}
                  >
                    <ImportIcon class="h-4 w-4" />
                  </button>
                </Show>
                {/* Last, and there whether or not a journal is open: the keys
                    work either way. */}
                <ShortcutsHelp />
              </>
            }
          />
        }
        activity={
          <>
            <Show when={drawerOpen()}>
              <button
                type="button"
                onClick={toggleChrome}
                aria-label={t("nav.dismissMenu")}
                class="absolute inset-0 z-20 cursor-default bg-black/20"
              />
            </Show>
            <ActivityBar
              class={`${SLIDE} ${drawerOpen() ? "absolute inset-y-0 left-0 z-30" : ""}`}
              visible={railShown()}
              items={buttonsFor(NAV)}
              footer={buttonsFor(FOOT)}
              expanded={railExpanded()}
              onToggle={() => setRailExpanded((expanded) => !expanded)}
              expandLabel={t("nav.expandSidebar")}
              collapseLabel={t("nav.collapseSidebar")}
              // The trigger arrives already built, so Kobalte gets a wrapper to
              // attach its props and ref to. The wrapper has to be a real box:
              // display:contents would leave it nothing to measure, and the tooltip
              // would be placed at the origin and never notice the pointer leaving.
              renderTooltip={(label, trigger) => (
                <Tooltip placement="right" gutter={8}>
                  <TooltipTrigger as="span" class="block w-full">
                    {trigger}
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              )}
            />
          </>
        }
        panel={
          <SidePanel
            class={`${SLIDE} ${drawerOpen() ? "absolute inset-y-0 z-30" : ""}`}
            style={drawerOpen() ? { left: `${(railExpanded() ? 208 : RAIL) + 1}px` } : undefined}
            // Pinned rather than merely allowed: a width whose floor and ceiling
            // are the same cannot be dragged off it, which is what makes the
            // explorer take the window whole and stay there.
            minWidth={() => (drawerOpen() ? drawerPanelWidth() : snapped() ? wholeWindow() : 168)}
            maxWidth={() => (drawerOpen() ? drawerPanelWidth() : snapped() ? wholeWindow() : withinWindow())}
            open={panelShown()}
            header={<span>{current().label()}</span>}
            onClose={drawerOpen() ? toggleChrome : undefined}
            closeLabel={t("nav.closeMenu")}
          >
            <Show when={explorerKey()} keyed>
              <Dynamic component={current().Explorer} onChosen={chose} />
            </Show>
          </SidePanel>
        }
        aux={
          <AuxPanel
            class={SLIDE}
            initialWidth={420}
            minWidth={320}
            maxWidth={withinWindow}
            open={dock.showing() !== undefined}
            header={<span>{dockTitle(dock.showing())}</span>}
            onClose={putDown}
            closeLabel={steppingBack() ? t("ai.back") : t("compose.close")}
            closeIcon={
              steppingBack() ? (
                <span class="inline-flex items-center gap-0.5 px-1 normal-case tracking-normal">
                  <ChevronLeftIcon class="h-3.5 w-3.5" />
                  {t("ai.back")}
                </span>
              ) : undefined
            }
          >
            {/* One dock, one thing at a time beside the books. */}
            <Show when={dock.showing() === "editing"}>
              <EntryEditor />
            </Show>
            <Show when={dock.showing() === "reviewing"}>
              <ProposalReview />
            </Show>
            <Show when={dock.showing() === "importing"}>
              <AiImportPanel />
            </Show>
            <Show when={dock.showing() === "csv-importing"}>
              <CsvImportPanel />
            </Show>
            <Show when={dock.showing() === "connecting"}>
              <JevKeyPanel />
            </Show>
            <Show when={dock.showing() === "composing"}>
              <ComposePanel />
            </Show>
            <Show when={dock.showing() === "ledger" && ledgerHasAPlace(appPath(location.pathname))}>
              <AccountLedger historical={statementAt(location.hash).historical} />
            </Show>
          </AuxPanel>
        }
      >
        {/* A column at least as tall as the screen, so a page that wants the
            height it has can take it with flex-1 — the text editor does — while
            one taller than the screen still grows and scrolls as it always
            did. */}
        <div
          class="flex min-h-full flex-col"
          style={{ "--stuck-above": snapped() && !chromeShowing() ? "2.25rem" : "0px" }}
        >
          <BackupNotice saveRequest={saveRequest}>
            <>
              {/* Above the work rather than in it, and only where the work is a
                  screen of its own: with the rail and the explorer put away there
                  is nothing else on this screen that leads back to them. Sticky,
                  because the work below it scrolls, and its height is what
                  --stuck-above tells the work to pin its own headings under. */}
              <Show when={snapped() && !chromeShowing()}>
                <button
                  type="button"
                  onClick={toggleChrome}
                  aria-label={t("nav.back")}
                  title={t("nav.back")}
                  class="sticky top-0 z-10 flex h-9 w-full items-center gap-1 border-b border-border bg-background px-2 text-sm font-medium text-muted-foreground"
                >
                  <ChevronLeftIcon class="h-4 w-4" />
                  <span class="truncate">{current().label()}</span>
                </button>
              </Show>
              {/* A phone has no width to spare, and the scrollbar already keeps
                  the right edge off the glass, so the gutter there is its own. */}
              <div class={`flex flex-1 flex-col ${snapped() ? "py-4 pl-2 pr-0" : "p-4"}`}>{props.children}</div>
            </>
          </BackupNotice>
        </div>
      </Shell>
    </>
  )
}

type SyncAttention =
  | { readonly at: "changed"; readonly files: readonly string[] }
  | { readonly at: "check" }

type SyncFailure =
  | { readonly at: "github"; readonly snag: GitHubSnag }
  | { readonly at: "drive"; readonly snag: DriveTrouble }
  | { readonly at: "local"; readonly trouble: LocalTrouble }

const syncFailureView = (failure: SyncFailure): JSX.Element => {
  switch (failure.at) {
    case "github": return <div class="flex flex-col gap-2">
      <GitHubSnagNote snag={failure.snag} />
      <Show when={failure.snag.at === "diverged" && failure.snag.snapshot}>{(snapshot) => {
        const file = snapshot()
        const local = file.local.content?.kind === "text" ? file.local.content.text : t("github.noSuchFile")
        const destination = file.destination.content?.kind === "text" ? file.destination.content.text : t("github.noSuchFile")
        const proposal = failure.snag.at === "diverged" ? failure.snag.proposal : undefined
        return <details class="rounded border p-2 text-xs">
          <summary class="cursor-pointer font-medium">{t("github.compare")}: {file.path}</summary>
          <div class="mt-2 grid gap-2 md:grid-cols-2">
            <section class="min-w-0"><h3 class="mb-1 font-medium">{t("github.thisCopy")}</h3><pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{local}</pre></section>
            <section class="min-w-0"><h3 class="mb-1 font-medium">{t("github.destinationCopy")}</h3><pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{destination}</pre></section>
          </div>
          <Show when={proposal}><section class="mt-2"><h3 class="mb-1 font-medium">{t("github.mergeProposal")}</h3><pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{proposal}</pre></section></Show>
        </details>
      }}</Show>
    </div>
    case "drive": return failure.snag.at === "conflict" || failure.snag.at === "local-changes"
      ? <p class="text-sm text-muted-foreground">{t("syncResolution.providerUnavailable", { files: failure.snag.path })}</p>
      : <DriveSnag snag={failure.snag} />
    case "local": return failure.trouble.at === "hledger"
      ? <TroubleNote trouble={failure.trouble.trouble} />
      : <p class="text-sm text-error-foreground">{localFailureWords(failure.trouble)}</p>
  }
}

const syncAttentionWords = (attention: SyncAttention): string =>
  attention.at === "changed"
    ? t("remotes.syncChanged", { files: attention.files.join(", ") })
    : t("remotes.syncCheck")

const noteRemoteAttention = (bookId: string, attention: SyncAttention | undefined): void => {
  if (attention === undefined) noteRemoteChangePaths(bookId, [])
  else if (attention.at === "changed") noteRemoteChangePaths(bookId, attention.files)
  else noteRemoteChangesUnavailable(bookId)
}

const isLocalFolderActive = (current: { readonly local?: unknown; readonly remote?: unknown }): boolean =>
  current.local !== undefined && current.remote === undefined

const localFailureAsTrouble = (failure: LocalResolutionFailure): LocalTrouble => {
  if (failure.at === "local") return failure.failure
  if (failure.at === "hledger") return { at: "hledger", trouble: failure.trouble }
  if (failure.at === "stale") return { at: "changed", path: failure.path }
  if (failure.at === "unsupported") return { at: "unsaved" }
  return failure.failure
}

type SyncResolutionFailure = GitHubResolutionFailure | DriveResolutionFailure | LocalResolutionFailure

const staleResolution = (failure: SyncResolutionFailure): boolean => failure.at === "stale"

const renderResolutionFailure = (failure: SyncResolutionFailure): JSX.Element => {
  if (failure.at === "stale") return <p class="text-sm text-error-foreground">{t("syncResolution.stale", { path: failure.path })}</p>
  if (failure.at === "unsupported") return <p class="text-sm text-error-foreground">{t("syncResolution.unsupported", { path: failure.path })}</p>
  if (failure.at === "github" || failure.at === "diverged" || failure.at === "not-connected" || failure.at === "no-place" || failure.at === "no-journal" || failure.at === "partial" || failure.at === "local-changes") {
    return githubResolutionFailure(failure)
  }
  if (failure.at === "drive") return <DriveSnag snag={{ at: "drive", failure: failure.failure }} />
  if (failure.at === "local") return <p class="text-sm text-error-foreground">{localFailureWords(failure.failure)}</p>
  if (failure.at === "hledger") return <TroubleNote trouble={failure.trouble} />
  if (failure.at === "local-kept") return <p class="text-sm text-error-foreground">{t("syncResolution.failed")}</p>
  if (failure.at === "uncertain") return <p class="text-sm text-error-foreground">{t("syncResolution.uncertain", { path: failure.path })}</p>
  return <p class="text-sm text-error-foreground">{t("syncResolution.failed")}</p>
}

function BackupNotice(props: { readonly saveRequest: Accessor<number>; readonly children: JSX.Element }): JSX.Element {
  const location = useLocation()
  const moves = useMoves()
  const open = () => getOrUndefined(journal())
  const [driveIdentityStatus, setDriveIdentityStatus] = createSignal<"loading" | "ready" | "failed">("loading")
  const [checkRevision, setCheckRevision] = createSignal(0)
  const [syncing, setSyncing] = createSignal(false)
  const [syncMessage, setSyncMessage] = createSignal<string | undefined>()
  const [syncFailure, setSyncFailure] = createSignal<SyncFailure | undefined>()
  const [conflicts, setConflicts] = createSignal<readonly FileSnapshot[] | undefined>()
  const [selectedConflictPath, setSelectedConflictPath] = createSignal<string | undefined>()
  const onRemotePage = (): boolean => appPath(location.pathname) === REMOTES
  const selectedPath = (): string | undefined => {
    if (!onRemotePage()) return undefined
    const addressSelection = lookingAt(location.hash)
    return addressSelection.at === "remote-change" || addressSelection.at === "change"
      ? addressSelection.path
      : selectedConflictPath()
  }
  createEffect(on(() => `${location.pathname}${location.hash}`, () => {
    const addressSelection = onRemotePage() ? lookingAt(location.hash) : undefined
    setSelectedConflictPath(
      addressSelection?.at === "remote-change" || addressSelection?.at === "change"
        ? addressSelection.path
        : undefined,
    )
  }))
  const reviewingRemoteChange = (): boolean =>
    onRemotePage() && lookingAt(location.hash).at === "remote-change"
  const [savedResolutions] = createResource(
    () => {
      const current = open()
      return current !== undefined && isGitHubRemote(current.remote) ? current.bookId : undefined
    },
    resolutionsFor,
  )
  createEffect(on(savedResolutions, (saved) => {
    const current = open()
    if (saved?.ok && current !== undefined && conflicts() === undefined) {
      const latest = saved.value.reduce((found, session) => session.createdAt > (found?.createdAt ?? 0) ? session : found, undefined as typeof saved.value[number] | undefined)
      if (latest?.bookId === current.bookId) {
        setConflicts(latest.snapshots)
        noteRemoteChangeSnapshots(current.bookId, latest.snapshots)
      }
    }
  }))
  onMount(() => {
    void loadDriveIdentity().then((result) => setDriveIdentityStatus(result.ok ? "ready" : "failed"))
    const refresh = (): void => {
      setCheckRevision((revision) => revision + 1)
      refreshBehind()
      noteDriveChecked()
    }
    const visible = (): void => {
      if (document.visibilityState === "visible") refresh()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", visible)
    })
  })
  const [syncAttention] = createResource(
    () => {
      const current = open()
      return current === undefined ? undefined : [
        current.bookId,
        JSON.stringify(current.remote),
        current.local?.handle.name ?? "",
        githubAgreements(),
        driveAgreementRevision(),
        driveCheckRevision(),
        behindNow().join("\n"),
        checkRevision(),
      ].join("\u0000")
    },
    async (): Promise<SyncAttention | undefined> => {
      const current = open()
      if (current === undefined) return undefined
      if (isGitHubRemote(current.remote) && current.remote.path !== "") {
        noteRemoteChangesChecking(current.bookId)
        if (await githubToken() === undefined) {
          noteRemoteChangesUnavailable(current.bookId)
          return { at: "check" }
        }
        const inspected = await inspectGitHub()
        const attention: SyncAttention | undefined = inspected.ok
          ? inspected.value.length > 0 ? { at: "changed", files: inspected.value.map(({ path }) => path) } : undefined
          : { at: "check" }
        noteRemoteAttention(current.bookId, attention)
        return attention
      }
      if (isGoogleDriveRemote(current.remote) && current.remote.path !== "") {
        noteRemoteChangesChecking(current.bookId)
        const id = await driveClientId()
        const session = id === undefined ? undefined : driveSessionToken(id)
        if (session === undefined) {
          noteRemoteChangesUnavailable(current.bookId)
          return { at: "check" }
        }
        const result = await driveBehind()
        const attention: SyncAttention | undefined = result.ok
          ? result.value.length > 0 ? { at: "changed", files: result.value } : undefined
          : { at: "check" }
        noteRemoteAttention(current.bookId, attention)
        return attention
      }
      if (current.local !== undefined) {
        const result = await changedOnDisk(current)
        return result.ok
          ? result.value.length > 0 ? { at: "changed", files: result.value } : undefined
          : { at: "check" }
      }
      return undefined
    },
  )
  const syncLatest = async (): Promise<void> => {
    const current = open()
    if (current === undefined) return
    setSyncing(true)
    setSyncMessage(undefined)
    setSyncFailure(undefined)
    setConflicts(undefined)
    if (isGitHubRemote(current.remote)) {
      const inspected = await inspectGitHub()
      if (!inspected.ok) setSyncFailure({ at: "github", snag: inspected.error })
      else {
        if (inspected.value.length > 0) {
          setConflicts(inspected.value)
          setSyncMessage(t("remotes.reviewInRemote"))
          noteRemoteChangeSnapshots(current.bookId, inspected.value)
        } else {
          noteRemoteChangeSnapshots(current.bookId, [])
          const pending = await githubUnsent(open() ?? current)
          const result = pending.length > 0 ? await githubPush() : await githubPull()
          if (result.ok) setSyncMessage(t("remotes.syncDone"))
          else if (result.error.at === "diverged" && result.error.snapshot !== undefined) {
            setConflicts([result.error.snapshot])
            setSyncMessage(t("remotes.reviewInRemote"))
            noteRemoteChangeSnapshots(current.bookId, [result.error.snapshot])
          }
          else setSyncFailure({ at: "github", snag: result.error })
        }
      }
    } else if (isGoogleDriveRemote(current.remote)) {
      const id = driveClientIdNow()
      const authorization = driveAccessToken(id)
      const authorised = await authorization
      if (!authorised.ok) setSyncFailure({ at: "drive", snag: { at: "not-connected" } })
      else {
        await keepDriveClientId(id)
        const inspected = await inspectDrive()
        if (!inspected.ok) setSyncFailure({ at: "drive", snag: inspected.error })
        else if (inspected.value.length > 0) {
          setConflicts(inspected.value)
          setSyncMessage(t("remotes.reviewInRemote"))
          noteRemoteChangeSnapshots(current.bookId, inspected.value)
        }
        else {
          noteRemoteChangeSnapshots(current.bookId, [])
          const pending = await driveUnsent(open() ?? current)
          const result = pending.length > 0 ? await drivePush() : await drivePull()
          if (result.ok) setSyncMessage(t("remotes.syncDone"))
          else if (result.error.at === "conflict" || result.error.at === "local-changes") {
            const refreshed = await inspectDrive()
            if (refreshed.ok && refreshed.value.length > 0) {
              setConflicts(refreshed.value)
              setSyncMessage(t("remotes.reviewInRemote"))
              noteRemoteChangeSnapshots(current.bookId, refreshed.value)
            }
            else setSyncMessage(t("syncResolution.providerUnavailable", { files: result.error.path }))
          } else setSyncFailure({ at: "drive", snag: result.error })
        }
      }
    } else if (current.local !== undefined) {
      const permitted = await permitLocalFolder(current.local)
      if (!permitted.ok) setSyncFailure({ at: "local", trouble: permitted.error })
      else {
        const inspected = await inspectLocalResolution()
        if (!inspected.ok) setSyncFailure({ at: "local", trouble: localFailureAsTrouble(inspected.error) })
        else if (inspected.value.length > 0) {
          setConflicts(inspected.value)
          setSyncMessage(t("remotes.reviewInRemote"))
          noteRemoteChangeSnapshots(current.bookId, inspected.value)
        }
        else {
          noteRemoteChangeSnapshots(current.bookId, [])
          const latest = open() ?? current
          const changed = await changedOnDisk(latest)
          if (!changed.ok) setSyncFailure({ at: "local", trouble: changed.error })
          else if (changed.value.length === 0) {
            if (await localFolderHasPending(latest)) {
              const result = await saveToLocalFolder()
              if (result.ok) setSyncMessage(t("remotes.syncDone"))
              else setSyncFailure({ at: "local", trouble: result.error })
            } else {
              const result = await reloadLocalFolder()
              if (result.ok) setSyncMessage(t("remotes.syncDone"))
              else setSyncFailure({ at: "local", trouble: result.error })
            }
          }
        }
      }
    } else setSyncMessage(t("remotes.syncDone"))
    setCheckRevision((revision) => revision + 1)
    refreshBehind()
    noteDriveChecked()
    setSyncing(false)
  }
  const refreshComparison = async (): Promise<void> => {
    const current = open()
    if (current === undefined) return
    setSyncing(true)
    setSyncFailure(undefined)
    const inspected = isGitHubRemote(current.remote)
      ? await inspectGitHub()
      : isGoogleDriveRemote(current.remote)
        ? await inspectDrive()
        : current.local !== undefined ? await inspectLocalResolution() : undefined
    if (inspected === undefined) setConflicts(undefined)
    else if (!inspected.ok) {
      if (isGitHubRemote(current.remote)) setSyncFailure({ at: "github", snag: inspected.error as GitHubSnag })
      else if (isGoogleDriveRemote(current.remote)) {
        setSyncFailure({ at: "drive", snag: inspected.error as DriveTrouble })
        noteRemoteChangesUnavailable(current.bookId)
      }
      else setSyncFailure({ at: "local", trouble: localFailureAsTrouble(inspected.error as LocalResolutionFailure) })
    } else if (inspected.value.length > 0) {
      setConflicts(inspected.value)
      noteRemoteChangeSnapshots(current.bookId, inspected.value)
    }
    else {
      const saved = await resolutionsFor(current.bookId)
      const forgotten = saved.ok ? await Promise.all(saved.value.map((session) => forgetResolution(session.id))) : []
      setConflicts(undefined)
      noteRemoteChangeSnapshots(current.bookId, [])
      setSyncMessage(saved.ok && forgotten.every((result) => result.ok)
        ? t("syncResolution.noConflicts")
        : t("syncResolution.storageFailed"))
    }
    noteDriveChecked()
    setSyncing(false)
  }
  createEffect(on(remoteReviewRequest, (request) => {
    if (request === undefined) return
    setSyncMessage(undefined)
    setSelectedConflictPath(request.path)
    const current = open()
    const cached = remoteChangesNow()
    if (
      current !== undefined &&
      cached?.bookId === current.bookId &&
      cached.at === "ready" &&
      cached.snapshots !== undefined
    ) {
      setSyncFailure(undefined)
      setConflicts(cached.snapshots)
      return
    }
    if (syncing()) return
    void refreshComparison()
  }))
  const [hasUnsentFile, { refetch }] = createResource(
    () => {
      const current = open()
      return current === undefined
        ? undefined
        : {
            current,
            agreements: isGitHubRemote(current.remote)
              ? githubAgreements()
              : isGoogleDriveRemote(current.remote) ? driveAgreementRevision() : undefined,
          }
    },
    async ({ current }) => {
      if (isGitHubRemote(current.remote)) return (await githubUnsent(current)).length > 0
      if (isGoogleDriveRemote(current.remote)) return (await driveUnsent(current)).length > 0
      return localFolderHasPending(current)
    },
  )
  const show = (): boolean =>
    (open()?.remote !== undefined || open()?.local !== undefined) && hasUnsentFile() === true
  const openRemoteReview = (): void => moves.goTo(REMOTES)
  const selectedConflict = (): FileSnapshot | undefined =>
    conflicts()?.find(({ path }) => path === selectedPath())

  return (
    <Show when={selectedConflict()} fallback={
      <>
      <Show when={!reviewingRemoteChange()}>
        <>
      <Show when={syncAttention()}>{(attention) => (
        <aside class="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="alert">
          <CloudIcon class="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <div class="min-w-0 flex-1">
            <p class="font-medium">{syncAttentionWords(attention())}</p>
          </div>
          <Button size="sm" variant="outline" disabled={syncing() || (isGoogleDriveRemote(open()?.remote) && driveIdentityStatus() === "loading")} onClick={() => void syncLatest()}>{syncing() ? t("remotes.syncing") : t("remotes.syncNow")}</Button>
        </aside>
      )}</Show>
      <Show when={syncMessage()}>{(message) => <div role="status" class="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <p>{message()}</p>
        <Show when={(conflicts()?.length ?? 0) > 0 && !onRemotePage()}>
          <Button size="sm" variant="outline" onClick={openRemoteReview}>{t("remotes.openRemote")}</Button>
        </Show>
      </div>}</Show>
      <Show when={syncFailure()}>{(failure) => <div class="mb-3 flex flex-col gap-1"><p class="text-sm text-error-foreground">{t("remotes.syncFailed")}</p>{syncFailureView(failure())}</div>}</Show>
      <Show when={show()}>
        <aside class="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" aria-label={t("remotes.warningTitle")}>
          <CloudIcon class="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <div class="min-w-0 flex-1">
            <p class="font-medium">{t("remotes.warningTitle")}</p>
            <p class="text-xs text-muted-foreground">{t("remotes.warningBody")}</p>
          </div>
          <BackupButton onSaved={refetch} saveRequest={props.saveRequest} />
        </aside>
      </Show>
        </>
      </Show>
      {props.children}
      </>
    }>
      {(snapshot) => {
        const current = open()
        const snapshots = conflicts()
        return current === undefined || snapshots === undefined ? undefined : <div class="mb-3">
          <SyncResolutionPanel
            bookId={current.bookId}
            snapshots={snapshots}
            selectedPath={snapshot().path}
            onLater={() => {
              setSelectedConflictPath(undefined)
              moves.goTo(REMOTES)
            }}
            onApplied={() => {
              setConflicts(undefined)
              setSelectedConflictPath(undefined)
              noteRemoteChangeSnapshots(current.bookId, [])
              moves.goTo(REMOTES)
              setCheckRevision((revision) => revision + 1)
              refreshBehind()
              noteDriveChecked()
            }}
            onSnapshotsChange={(remaining, nextPath) => {
              setConflicts(remaining)
              noteRemoteChangeSnapshots(current.bookId, remaining)
              setSelectedConflictPath(nextPath)
              moves.goTo(nextPath === undefined ? REMOTES : addressOf({ at: "remote-change", path: nextPath }))
            }}
            onRefresh={() => void refreshComparison()}
            resolveFile={(snapshot, choice) => isGitHubRemote(current.remote)
              ? resolveGitHub(snapshot, choice)
              : isGoogleDriveRemote(current.remote)
                ? resolveDrive(snapshot, choice)
                : resolveLocalResolution(snapshot, choice)}
            exportFile={(snapshot) => isGitHubRemote(current.remote)
              ? exportGitHub(snapshot)
              : isGoogleDriveRemote(current.remote)
                ? exportDrive(snapshot)
                : exportLocalResolution(snapshot)}
            exportRecovery={isLocalFolderActive(current) ? exportLocalResolution : undefined}
            renderFailure={renderResolutionFailure}
            isStale={staleResolution}
            warning={isGoogleDriveRemote(current.remote) ? t("syncResolution.driveWarning") : isLocalFolderActive(current) ? t("syncResolution.localWarning") : undefined}
          />
        </div>
      }}
    </Show>
  )
}
