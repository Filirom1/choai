import { createSignal } from "solid-js"

const [reviewRequest, setReviewRequest] = createSignal<{ readonly path: string }>()

export const remoteReviewRequest = reviewRequest

export const requestRemoteReview = (path: string): void => {
  setReviewRequest({ path })
}
