# Security

Please report security issues through GitHub's private vulnerability reporting on this repository's **Security** tab, not in a public issue.

Do not include real meeting audio, transcripts, names, credentials, or other personal data in a report. A minimal reproduction using synthetic audio or text is enough.

The plugin processes audio and meeting text locally. Its Host routes are authenticated by the DSH connection layer; the plugin does not add an unauthenticated HTTP listener. Review the source before installing a modified copy.
