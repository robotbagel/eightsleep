// sleepShortcut.ts
// Generates an unsigned iOS 26 .shortcut (XML plist) that, each morning,
// reads last night's Apple Health sleep samples and POSTs them as
// "Stage,startISO,endISO" lines to the healthImport endpoint (token in the
// URL, so no custom header is needed).
//
// Flow: Find Health Samples (Sleep Analysis, last 1 day) -> Repeat with Each
// -> Text "value,start,end" -> Combine (newlines) -> Get Contents of URL POST.
//
// NOTE: Apple's Health action internals are version-specific and cannot be
// run-tested outside iOS. The identifiers below target iOS 26; if import or
// run fails, the manual recipe in the UI is the fallback.

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Stable UUIDs for the actions whose output is referenced later.
const FIND_UUID = "A1F1D0A1-0000-4000-8000-000000000001";
const LINE_UUID = "A1F1D0A1-0000-4000-8000-000000000002";
const COMBINE_UUID = "A1F1D0A1-0000-4000-8000-000000000003";
const REPEAT_GROUP = "A1F1D0A1-0000-4000-8000-0000000000AA";

// A WFTextTokenString whose whole content is a single magic-variable
// attachment (an action output referenced by UUID).
function magicVarField(outputUUID: string, outputName: string): string {
  return `
        <dict>
          <key>Value</key>
          <dict>
            <key>attachmentsByRange</key>
            <dict>
              <key>{0, 1}</key>
              <dict>
                <key>Type</key><string>ActionOutput</string>
                <key>OutputUUID</key><string>${outputUUID}</string>
                <key>OutputName</key><string>${esc(outputName)}</string>
                <key>Aggrandizements</key><array/>
              </dict>
            </dict>
            <key>string</key><string>￼</string>
          </dict>
          <key>WFSerializationType</key><string>WFTextTokenString</string>
        </dict>`;
}

// A text field mixing literal text with Repeat Item properties (Sleep value,
// Start/End date), each an attachment with a property Aggrandizement.
function lineTemplateField(): string {
  // "￼,￼,￼" — three attachments separated by commas.
  const attach = (property: string, offset: number) => `
              <key>{${offset}, 1}</key>
              <dict>
                <key>Type</key><string>Variable</string>
                <key>VariableName</key><string>Repeat Item</string>
                <key>Aggrandizements</key>
                <array>
                  <dict>
                    <key>Type</key><string>WFPropertyVariableAggrandizement</string>
                    <key>PropertyName</key><string>${esc(property)}</string>
                  </dict>
                </array>
              </dict>`;
  return `
        <dict>
          <key>Value</key>
          <dict>
            <key>attachmentsByRange</key>
            <dict>${attach("Sleep", 0)}${attach("Start Date", 2)}${attach("End Date", 4)}
            </dict>
            <key>string</key><string>￼,￼,￼</string>
          </dict>
          <key>WFSerializationType</key><string>WFTextTokenString</string>
        </dict>`;
}

export function buildSleepShortcutPlist(endpoint: string, token: string): string {
  const postUrl = `${endpoint}?token=${encodeURIComponent(token)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowClientVersion</key><string>3000.0.1</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>946986751</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>61440</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowTypes</key><array><string>WatchKit</string></array>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
    <string>WFAppStoreAppContentItem</string>
    <string>WFArticleContentItem</string>
    <string>WFContactContentItem</string>
    <string>WFDateContentItem</string>
    <string>WFEmailAddressContentItem</string>
    <string>WFGenericFileContentItem</string>
    <string>WFImageContentItem</string>
    <string>WFiTunesProductContentItem</string>
    <string>WFLocationContentItem</string>
    <string>WFDCMapsLinkContentItem</string>
    <string>WFAVAssetContentItem</string>
    <string>WFPDFContentItem</string>
    <string>WFPhoneNumberContentItem</string>
    <string>WFRichTextContentItem</string>
    <string>WFSafariWebPageContentItem</string>
    <string>WFStringContentItem</string>
    <string>WFURLContentItem</string>
  </array>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.filter.health.category</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${FIND_UUID}</string>
        <key>WFCategorySampleType</key><string>Sleep Analysis</string>
        <key>WFContentItemFilter</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>WFContentPredicateBoundedDate</key><false/>
            <key>WFActionParameterFilterPrefix</key><integer>1</integer>
            <key>WFActionParameterFilterTemplates</key>
            <array>
              <dict>
                <key>Property</key><string>Start Date</string>
                <key>Operator</key><integer>1002</integer>
                <key>Values</key>
                <dict>
                  <key>Unit</key><integer>4</integer>
                  <key>Amount</key><integer>1</integer>
                </dict>
              </dict>
            </array>
          </dict>
          <key>WFSerializationType</key><string>WFContentPredicateTableTemplate</string>
        </dict>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.repeat.each</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFControlFlowMode</key><integer>0</integer>
        <key>GroupingIdentifier</key><string>${REPEAT_GROUP}</string>
        <key>WFInput</key>${magicVarField(FIND_UUID, "Sleep Samples")}
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.gettext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${LINE_UUID}</string>
        <key>WFTextActionText</key>${lineTemplateField()}
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.repeat.each</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFControlFlowMode</key><integer>2</integer>
        <key>GroupingIdentifier</key><string>${REPEAT_GROUP}</string>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.text.combine</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${COMBINE_UUID}</string>
        <key>WFTextSeparator</key><string>New Lines</string>
        <key>text</key>${magicVarField(LINE_UUID, "Repeat Results")}
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFURL</key><string>${esc(postUrl)}</string>
        <key>WFHTTPMethod</key><string>POST</string>
        <key>WFHTTPBodyType</key><string>File</string>
        <key>WFRequestVariable</key>${magicVarField(COMBINE_UUID, "Combined Text")}
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
