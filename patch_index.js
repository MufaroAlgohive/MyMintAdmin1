const fs = require('fs');

const file = '/Users/mufaroncube/Documents/MyMintAdmin1/public/index.html';
let content = fs.readFileSync(file, 'utf8');

const replacement = `window.addEventListener('access-guard:ready', function() {
  if (typeof window.mintCan !== 'function') return;

  // Manage KYC
  if (!window.mintCan('clients', 'manage_kyc')) {
    var style = document.createElement('style');
    style.innerHTML = \`
      .cert-btn-accept, .cert-btn-reject, .cert-btn-reevaluate, 
      [data-child-accept], [data-child-reject] {
        display: none !important;
      }
    \`;
    document.head.appendChild(style);
  }

  // Edit Profiles
  if (!window.mintCan('clients', 'edit_profiles')) {
    var phoneSave = document.getElementById('phoneModalSave');
    if (phoneSave) {
      phoneSave.disabled = true;
      phoneSave.title = 'You do not have permission to edit profiles';
      phoneSave.style.opacity = '0.4';
      phoneSave.style.cursor = 'not-allowed';
    }
  }
});
</script>`;

content = content.replace('</script>\n</body>', replacement + '\n</body>');
fs.writeFileSync(file, content);
console.log('Patched index.html');
