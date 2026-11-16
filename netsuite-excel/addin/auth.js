// Sign-in via an Office dialog: /.auth/login/aad -> (Entra) -> /signin-complete.html -> messageParent.
// OPEN RISK #1: this flow is unproven inside real Excel (cookie sharing between dialog and task pane).

export function signIn() {
  return new Promise((resolve, reject) => {
    const url = `${location.origin}/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent('/signin-complete.html')}`;
    Office.context.ui.displayDialogAsync(url, { height: 60, width: 30, promptBeforeOpen: false }, (res) => {
      if (res.status !== Office.AsyncResultStatus.Succeeded) {
        reject(new Error('Could not open the sign-in window.'));
        return;
      }
      const dialog = res.value;
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
        dialog.close();
        const msg = 'message' in arg ? arg.message : '';
        if (msg === 'signed-in') resolve();
        else reject(new Error('Sign-in did not complete.'));
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, () => reject(new Error('The sign-in window was closed.')));
    });
  });
}
