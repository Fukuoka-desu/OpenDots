export type ReportSlot = {
  id: 'morning' | 'noon' | 'evening';
  label: '朝' | '昼' | '夕方';
  time: string;
  prompt: string;
};

export const reportSlots: ReportSlot[] = [
  {
    id: 'morning',
    label: '朝',
    time: '09:00',
    prompt:
      '【定時報告｜朝】朝のブリーフをお願いします。calendar_list_events で今日の予定を、gmail_search_messages で直近24時間の未読メール（is:unread newer_than:1d）を確認して、次の形でまとめてください。1) 今日の予定（時刻・件名） 2) 返信や対応が必要そうなメール（最大3件、理由つき） 3) この会話で未完了の依頼 4) 今日最初にやるとよいこと1つ。全体で10行以内。ツールが使えない・エラーになった項目は「取得できませんでした」と書き、メールなど別の情報から推測で埋めないこと。メールの送信や予定の作成はしないこと。',
  },
  {
    id: 'noon',
    label: '昼',
    time: '12:30',
    prompt:
      '【定時報告｜昼】昼の進捗報告をお願いします。calendar_list_events で午後の予定を、gmail_search_messages で朝以降の未読メール（is:unread newer_than:6h）を確認して、1) 午後の予定 2) 新しく対応が必要なこと 3) この会話で進行中・未完了の依頼 を8行以内でまとめてください。ツールが使えない・エラーになった項目は「取得できませんでした」と書き、メールなど別の情報から推測で埋めないこと。メールの送信や予定の作成はしないこと。',
  },
  {
    id: 'evening',
    label: '夕方',
    time: '17:30',
    prompt:
      '【定時報告｜夕方】今日の振り返りをお願いします。この会話で今日終わったことと残っていることを整理し、calendar_list_events で明日の予定を確認して、1) 今日やったこと 2) 持ち越し 3) 明日の予定と準備しておくこと を8行以内でまとめてください。ツールが使えない・エラーになった項目は「取得できませんでした」と書き、メールなど別の情報から推測で埋めないこと。メールの送信や予定の作成はしないこと。',
  },
];

export const reportMarker = /^【定時報告｜(朝|昼|夕方)】/;

function datePart(now: Date, type: 'year' | 'month' | 'day') {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .find((part) => part.type === type)?.value ?? ''
  );
}

export function jstDay(now: Date): string {
  return `${datePart(now, 'year')}-${datePart(now, 'month')}-${datePart(now, 'day')}`;
}

function jstMinutes(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(
    parts.find((part) => part.type === 'minute')?.value ?? 0,
  );
  return { hour, minute, total: hour * 60 + minute };
}

export function dueReport(
  now: Date,
  done: string[],
): { slot?: ReportSlot; handled: string[] } | undefined {
  const { total } = jstMinutes(now);
  const due = reportSlots.filter(
    (slot) =>
      Number(slot.time.slice(0, 2)) * 60 + Number(slot.time.slice(3)) <=
        total && !done.includes(slot.id),
  );
  const latest = due.at(-1);
  if (!latest) return undefined;
  const scheduled = Date.parse(`${jstDay(now)}T${latest.time}:00+09:00`);
  return {
    ...(now.getTime() - scheduled <= 3 * 60 * 60_000 ? { slot: latest } : {}),
    handled: due.map((slot) => slot.id),
  };
}

export function slotForNow(now: Date): ReportSlot {
  const { hour } = jstMinutes(now);
  return reportSlots[hour < 11 ? 0 : hour < 15 ? 1 : 2]!;
}
