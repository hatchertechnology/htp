<script setup lang="ts">
import { formatInstant, zoneLabel } from '#shared/utils/local-time'
import {
  availabilityNotice, emptyText, episodeState, kindLabel, nextEventsQuery, parseEpisodesPage, parseEventsPage, unknownText,
  type EpisodeRow, type EventCursor, type EventRow, type EventsPage, type Producer,
} from '#shared/utils/audit-events-view'
// Stored, owner-scoped reads only. They never start a crawl, collection or
// event processing; availability describes the producer, not the site.
const props = defineProps<{ websiteId: string }>()
const { $supabase } = useNuxtApp()
type Panel<T> = { rows: T[]; hasMore: boolean; nextCursor: EventCursor | null; availability: string | null; producer: Producer | null; loaded: boolean; busy: boolean; error: string; retryMore: boolean }
const blank = <T,>(): Panel<T> => ({ rows: [], hasMore: false, nextCursor: null, availability: null, producer: null, loaded: false, busy: false, error: '', retryMore: false })
const events = reactive<Panel<EventRow>>(blank()), episodes = reactive<Panel<EpisodeRow>>(blank())
let generation = 0
function zone() { return zoneLabel() }
function stamp(value: string | null) { return value ? formatInstant(value) : 'Unknown' }
async function read<T>(panel: Panel<T>, rpc: string, parse: (raw: unknown) => EventsPage<T> | null, more: boolean, gen: number) {
  const cursor = more ? panel.nextCursor : null
  panel.busy = true; panel.error = ''; panel.retryMore = more
  try {
    const { data, error } = await $supabase.rpc(rpc, { p_website_id: props.websiteId, ...nextEventsQuery(cursor) })
    if (gen !== generation) return
    const parsed = error ? null : parse(data)
    if (!parsed) { panel.error = 'Stored history could not be read. This is not an empty history. Try again.'; return }
    panel.rows = more ? [...panel.rows, ...parsed.rows] : parsed.rows
    panel.hasMore = parsed.hasMore; panel.nextCursor = parsed.nextCursor; panel.availability = parsed.availability; panel.producer = parsed.producer; panel.loaded = true
  } catch { if (gen === generation) panel.error = 'Stored history could not be read. This is not an empty history. Try again.' }
  finally { if (gen === generation) panel.busy = false }
}
const loadEvents = (more = false) => read(events, 'audit_event_history', parseEventsPage, more, generation)
const loadEpisodes = (more = false) => read(episodes, 'audit_operational_history', parseEpisodesPage, more, generation)
function reload() {
  const gen = ++generation
  Object.assign(events, blank<EventRow>()); Object.assign(episodes, blank<EpisodeRow>())
  if (!props.websiteId) return
  void read(events, 'audit_event_history', parseEventsPage, false, gen)
  void read(episodes, 'audit_operational_history', parseEpisodesPage, false, gen)
}
watch(() => props.websiteId, reload, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>
<template>
  <section class="report-panel audit-events" aria-labelledby="audit-events-title" :aria-busy="events.busy || episodes.busy">
    <h3 id="audit-events-title">Alerts and operational history</h3>
    <p class="report-caption">Read-only history stored for this website, shown in your local time ({{ zone() }}). Reading it never starts a crawl, collection or alert processing. Event kinds are technical findings from saved audits; severity is technical, not business impact.</p>

    <h4>Audit events</h4>
    <p v-if="events.error" role="alert" class="form-error">{{ events.error }} <button class="refresh-control" :disabled="events.busy" @click="loadEvents(events.retryMore)">Try again</button></p>
    <p v-else-if="!events.loaded" role="status" class="compact-empty">Reading stored events…</p>
    <template v-if="events.loaded">
      <p :class="availabilityNotice(events.availability, events.rows.length, 'events', events.producer).tone === 'notice' ? 'form-notice' : 'report-caption'" role="status">{{ availabilityNotice(events.availability, events.rows.length, 'events', events.producer).text }}</p>
      <p v-if="!events.rows.length" class="compact-empty">{{ emptyText('events') }}</p>
      <div v-else class="table-scroll"><table><caption class="sr-only">Stored audit events, newest first</caption><thead><tr><th scope="col">Recorded ({{ zone() }})</th><th scope="col">Event</th><th scope="col">Severity</th><th scope="col">Rule</th><th scope="col">Page or resource</th><th scope="col">Audit</th></tr></thead>
        <tbody><tr v-for="row in events.rows" :key="row.id"><td><time v-if="row.created_at" :datetime="row.created_at" :title="row.created_at">{{ stamp(row.created_at) }}</time><template v-else>Unknown</template></td><td>{{ kindLabel(row.kind) }}</td><td>{{ unknownText(row.severity) }}</td><td>{{ unknownText(row.rule) }}</td><td>{{ row.source_locator ?? row.entity_id ?? 'Unknown' }}</td><td>{{ unknownText(row.delivery_id) }}</td></tr></tbody></table></div>
      <div v-if="events.hasMore" class="seo-pagination"><button class="refresh-control" type="button" :disabled="events.busy" @click="loadEvents(true)">Older events</button></div>
    </template>

    <h4>Provider failure episodes</h4>
    <p v-if="episodes.error" role="alert" class="form-error">{{ episodes.error }} <button class="refresh-control" :disabled="episodes.busy" @click="loadEpisodes(episodes.retryMore)">Try again</button></p>
    <p v-else-if="!episodes.loaded" role="status" class="compact-empty">Reading stored episodes…</p>
    <template v-if="episodes.loaded">
      <p :class="availabilityNotice(episodes.availability, episodes.rows.length, 'episodes').tone === 'notice' ? 'form-notice' : 'report-caption'" role="status">{{ availabilityNotice(episodes.availability, episodes.rows.length, 'episodes').text }}</p>
      <p v-if="!episodes.rows.length" class="compact-empty">{{ emptyText('episodes') }}</p>
      <div v-else class="table-scroll"><table><caption class="sr-only">Stored provider failure episodes, newest first</caption><thead><tr><th scope="col">Opened ({{ zone() }})</th><th scope="col">State</th><th scope="col">Recovered ({{ zone() }})</th><th scope="col">Source</th><th scope="col">Error class</th></tr></thead>
        <tbody><tr v-for="row in episodes.rows" :key="row.id"><td><time v-if="row.opened_at" :datetime="row.opened_at" :title="row.opened_at">{{ stamp(row.opened_at) }}</time><template v-else>Unknown</template></td><td>{{ episodeState(row) === 'open' ? 'Open: not yet recovered' : episodeState(row) === 'recovered' ? 'Recovered' : 'Unknown' }}</td><td><time v-if="row.recovered_at" :datetime="row.recovered_at" :title="row.recovered_at">{{ stamp(row.recovered_at) }}</time><template v-else>{{ episodeState(row) === 'open' ? 'Not recovered' : 'Unknown' }}</template></td><td>{{ unknownText(row.source) }}</td><td>{{ unknownText(row.error_class) }}</td></tr></tbody></table></div>
      <div v-if="episodes.hasMore" class="seo-pagination"><button class="refresh-control" type="button" :disabled="episodes.busy" @click="loadEpisodes(true)">Older episodes</button></div>
    </template>
  </section>
</template>
