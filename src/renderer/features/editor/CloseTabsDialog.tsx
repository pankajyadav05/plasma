import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSession } from '@/stores/session';

/**
 * "Close tabs with unsaved SQL?" (D1). Raised by `requestCloseTabs` when
 * any tab being closed has a buffer that differs from its saved text.
 */
export function CloseTabsDialog() {
  const request = useSession((s) => s.closeTabsRequest);
  const confirm = useSession((s) => s.confirmCloseTabs);
  const cancel = useSession((s) => s.cancelCloseTabs);
  const titles = request?.dirtyTitles ?? [];
  const single = titles.length === 1;
  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      title={
        single
          ? `Close “${titles[0]}” without saving?`
          : `Close ${titles.length} tabs without saving?`
      }
      description={
        single
          ? 'The SQL in this tab has not been saved to a file or saved query. Closing it discards the text.'
          : `Unsaved SQL in ${titles.join(', ')} will be discarded.`
      }
      confirmLabel={single ? 'Close tab' : 'Close tabs'}
      variant="destructive"
      onConfirm={confirm}
    />
  );
}
