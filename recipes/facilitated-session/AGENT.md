# Facilitated session

This recipe supports a facilitator, signed-in participants and a read-only shared display. The owner creates a guest invitation from Share and devices and approves each participant. Display links are read-only. Do not put private answers in shared state or the conversation transcript.

Public session state is `facilitation = {title?,stage:'collect'|'discuss'|'closed',prompt:{id,text,description?},summary:string}`. Use a new stable `prompt.id` for each question. The owner can publish a new question, review private responses, ask for a synthesis, close collection and publish an edited summary. Participants keep editable local drafts and can update only their own saved answer with a revision check. The room display reads shared state only and never requests private response endpoints.

An answer is stored by `POST _tendril/responses {prompt_id,answer,expected_revision?}`. `GET _tendril/responses` returns the authenticated person's responses. Only the owner can call `GET _tendril/responses/all`; the attached agent uses `GET A/responses`. The service enforces ownership and revision checks. Do not implement privacy by hiding DOM elements or filtering a shared answer array.

On a response event, fetch the private answer by its response id from `GET A/responses`. On `type=facilitation_summary_request`, aggregate the current prompt's answers. Ask the owner to review a short summary in the private agent-host conversation, or create an owner-only proposal through `POST A/decisions`. The owner can paste/edit that summary into “Summary to share” and publish it. Alternatively, after explicit approval, update the public summary and stage. Do not quote identifiable private answers to the group. Ordinary `say` and its device targeting share the transcript, so they are unsuitable for raw answers or an unreviewed private draft.

For testing, use distinct owner and guest authenticated accounts and a display link. Verify guests cannot read `/responses/all`, cannot update another participant's answer, and the public state and page events contain no raw answers. The included fixture covers the shared prompt flow; server tests cover access boundaries.
